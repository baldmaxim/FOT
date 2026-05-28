// Ретрофикс: заявление типа «работа» раньше зашивало часы по графику (work_hours||8)
// в attendance_adjustments. Теперь 'work' = только согласование, часы берутся из СКУД
// (см. attendance.service.ts: status==='work' && hours_override===null → часы из summary).
// Скрипт обнуляет hours_override у уже созданных записей status='work' source_type='leave_request',
// чтобы их часы тоже считались по факту СКУД (0, если не вышел).
//
// ВНИМАНИЕ: меняет отображаемое время в табеле за затронутый период. По умолчанию трогает
// только безопасный скоуп — pending + текущий открытый месяц (выгруженные в 1С табели не трогаются).
//
// Идемпотентен: повторный прогон обновит 0 строк (hours_override уже NULL).
//
// Usage:
//   node fot-server/scripts/null-work-leave-request-hours.mjs --dry-run        # превью (дефолт-скоуп)
//   node fot-server/scripts/null-work-leave-request-hours.mjs                  # применить (дефолт-скоуп)
//   node fot-server/scripts/null-work-leave-request-hours.mjs --from=2026-01-01 --dry-run
//   node fot-server/scripts/null-work-leave-request-hours.mjs --all            # вся история (ретроактивно!)

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has('--dry-run');
const all = args.has('--all');
const fromArg = argv.find(a => a.startsWith('--from='));
const fromDate = fromArg ? fromArg.slice('--from='.length) : null;
if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
  console.error('--from ожидает YYYY-MM-DD');
  process.exit(2);
}

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
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(p);
  connStr = u.toString();
  sanitizedHost = `${u.hostname}:${u.port || '5432'} / db=${u.pathname.replace(/^\//, '')}`;
} catch { /* ignore */ }

// Скоуп WHERE поверх базового фильтра (status='work' AND source_type='leave_request' AND hours_override IS NOT NULL).
let scopeSql;
let scopeLabel;
if (all) {
  scopeSql = 'TRUE';
  scopeLabel = 'ВСЯ ИСТОРИЯ (ретроактивно)';
} else if (fromDate) {
  scopeSql = `work_date >= '${fromDate}'::date`;
  scopeLabel = `с ${fromDate}`;
} else {
  scopeSql = `(approval_status = 'pending' OR work_date >= date_trunc('month', CURRENT_DATE)::date)`;
  scopeLabel = 'pending + текущий открытый месяц (дефолт)';
}

const client = new Client({ connectionString: connStr, ssl: { ca, rejectUnauthorized: true } });
await client.connect();
console.log(`БД: ${sanitizedHost}`);
console.log(`Скоуп: ${scopeLabel}`);
console.log(`Режим: ${dryRun ? 'DRY-RUN (без UPDATE)' : 'APPLY (с UPDATE)'}`);

const baseWhere =
  `status = 'work' AND source_type = 'leave_request' AND hours_override IS NOT NULL AND ${scopeSql}`;

const preview = (await client.query(
  `SELECT approval_status, COUNT(*)::int AS cnt,
          MIN(work_date)::text AS min_date, MAX(work_date)::text AS max_date
     FROM attendance_adjustments
    WHERE ${baseWhere}
    GROUP BY approval_status
    ORDER BY approval_status`,
)).rows;

const totalCandidates = preview.reduce((s, r) => s + r.cnt, 0);
console.log(`\nКандидатов (work/leave_request с зашитыми часами): ${totalCandidates}`);
for (const r of preview) {
  console.log(`  ${r.approval_status}: ${r.cnt} (${r.min_date} … ${r.max_date})`);
}

let updated = 0;
if (!dryRun && totalCandidates > 0) {
  updated = (await client.query(
    `UPDATE attendance_adjustments
        SET hours_override = NULL, updated_at = NOW()
      WHERE ${baseWhere}
      RETURNING id`,
  )).rowCount;
}

console.log('\n=== ИТОГ ===');
console.log(`  Кандидатов:            ${totalCandidates}`);
console.log(`  ${dryRun ? 'Будет обнулено' : 'Обнулено'}:        ${dryRun ? totalCandidates : updated}`);
if (dryRun) console.log('  (dry-run — изменений в БД не сделано)');

await client.end();
