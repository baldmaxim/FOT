// Read-only диагностика: дубликаты contractor_passes.pass_number, из-за которых
// «Отозвать» падает 500 (unique constraint contractor_passes_pool_pass_number_uniq).
// Печатает по каждому номеру: сколько записей в пуле / у подрядчиков и детали.
//
// Usage: node fot-server/scripts/diagnose-duplicate-pass-numbers.mjs [pass_number]

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const passNumberArg = (process.argv[2] || '').trim();

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[k] = v;
  }
  return out;
}

const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
const dbUrl = env.DATABASE_URL;
if (!dbUrl) { console.error('Missing DATABASE_URL in fot-server/.env'); process.exit(2); }
const ca = fs.readFileSync(CA_PATH, 'utf8');

let connStr = dbUrl;
let sanitizedHost = '<unknown>';
try {
  const u = new URL(dbUrl);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) {
    u.searchParams.delete(p);
  }
  connStr = u.toString();
  sanitizedHost = `${u.hostname}:${u.port || '5432'} / db=${u.pathname.replace(/^\//, '')}`;
} catch { /* ignore */ }

function section(t) { console.log(`\n=== ${t} ===`); }

const client = new Client({
  connectionString: connStr,
  ssl: { ca, rejectUnauthorized: true },
});

try {
  await client.connect();
  console.log(`БД host: ${sanitizedHost}`);

  section('1. Уникальные индексы и constraint на contractor_passes');
  const idx = (await client.query(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname='public' AND tablename='contractor_passes'
        AND (indexname ILIKE '%uniq%' OR indexname ILIKE '%pass_number%')
      ORDER BY indexname`,
  )).rows;
  if (idx.length === 0) console.log('  Уникальных индексов не найдено.');
  for (const r of idx) console.log(`  ${r.indexname}: ${r.indexdef}`);

  section('2. Все pass_number с >1 записями');
  const dupes = (await client.query(
    `SELECT
        p.pass_number,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE p.org_department_id IS NULL) AS in_pool_cnt,
        COUNT(*) FILTER (WHERE p.org_department_id IS NOT NULL) AS assigned_cnt,
        json_agg(json_build_object(
          'id', p.id,
          'status', p.status,
          'approval_status', p.approval_status,
          'org_department_id', p.org_department_id,
          'org_name', od.name,
          'holder_name', p.holder_name,
          'sigur_employee_id', p.sigur_employee_id,
          'card_uid', p.card_uid,
          'is_active', p.is_active,
          'updated_at', p.updated_at
        ) ORDER BY p.updated_at DESC) AS records
       FROM contractor_passes p
       LEFT JOIN org_departments od ON od.id = p.org_department_id
      ${passNumberArg ? "WHERE p.pass_number = $1" : ''}
      GROUP BY p.pass_number
      HAVING COUNT(*) > 1
      ORDER BY p.pass_number::int`,
    passNumberArg ? [passNumberArg] : [],
  )).rows;

  if (dupes.length === 0) {
    console.log(`  Дубликатов нет${passNumberArg ? ` для pass_number=${passNumberArg}` : ''}.`);
  } else {
    console.log(`  Найдено дубликатных pass_number: ${dupes.length}`);
    for (const d of dupes) {
      console.log(`\n  pass_number=${d.pass_number}  total=${d.total}  in_pool=${d.in_pool_cnt}  assigned=${d.assigned_cnt}`);
      for (const r of d.records) {
        const where = r.org_department_id ? `org=${r.org_name ?? r.org_department_id}` : 'POOL';
        console.log(
          `    id=${r.id} status=${r.status}/${r.approval_status} ${where} ` +
          `holder='${r.holder_name ?? '-'}' sigur=${r.sigur_employee_id ?? '-'} ` +
          `card=${r.card_uid ?? '-'} active=${r.is_active} upd=${r.updated_at}`,
        );
      }
    }
  }

  section('3. Сводка по статусам всех contractor_passes');
  const stats = (await client.query(
    `SELECT status,
            COUNT(*) AS cnt,
            COUNT(*) FILTER (WHERE org_department_id IS NULL) AS in_pool_null_dept,
            COUNT(*) FILTER (WHERE sigur_employee_id IS NULL) AS no_sigur_id
       FROM contractor_passes
      GROUP BY status
      ORDER BY status`,
  )).rows;
  for (const s of stats) {
    console.log(`  ${s.status.padEnd(12)} count=${s.cnt} (org_null=${s.in_pool_null_dept}, sigur_null=${s.no_sigur_id})`);
  }

  section('4. Подсказка по чистке');
  console.log(`  Для каждой "лишней" pool-копии (status=in_pool, org_department_id IS NULL,`);
  console.log(`  но Sigur профиль уже удалён руками) выполнить:`);
  console.log(`    UPDATE contractor_passes`);
  console.log(`       SET status='revoked', sigur_employee_id=NULL, is_active=false, updated_at=now()`);
  console.log(`     WHERE id = '<id-orphan>';`);
} finally {
  await client.end();
}
