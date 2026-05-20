// Read-only диагностика «фантомных» отделов/бригад: есть в org_departments
// с sigur_department_id, но больше не возвращаются Sigur API /api/v1/departments.
// Не вызывает Sigur — только показывает потенциальных кандидатов из БД:
// active отделы с sigur_department_id и сколько на них висит сотрудников.
//
// Оператор затем сравнивает выдачу с актуальным списком Sigur (curl)
// и принимает решение, какие из них действительно фантомы.
//
// Берёт DATABASE_URL из fot-server/.env и CA из .migration/yandex-ca.pem.
// Не модифицирует .env, БД-изменений не вносит.
//
// Usage:
//   node fot-server/scripts/diagnose-phantom-departments.mjs [name-substring ...]
//   без аргументов — показывает всех активных с sigur_department_id.

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const nameFilters = process.argv.slice(2);

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
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

function section(t) { console.log(`\n=== ${t} ===`); }

async function run(client) {
  console.log(`БД host: ${sanitizedHost}`);
  if (/supabase\.com/i.test(sanitizedHost)) {
    console.log('!!! ВНИМАНИЕ: host = Supabase-архив. Подставьте прод Yandex DATABASE_URL.');
  }
  const rep = await client.query('SELECT pg_is_in_recovery() AS r');
  console.log(`connected (${rep.rows[0].r ? 'replica' : 'PRIMARY'})`);
  if (nameFilters.length > 0) console.log(`Фильтр по имени (ILIKE): ${nameFilters.join(', ')}`);

  // --- 1. Активные с sigur_department_id (кандидаты на проверку «есть ли в Sigur») ---
  section('1. Активные отделы с sigur_department_id + сотрудники на них');
  const params = [];
  let where = `od.is_active = true AND od.sigur_department_id IS NOT NULL`;
  if (nameFilters.length > 0) {
    const orParts = nameFilters.map((_, i) => `od.name ILIKE $${i + 1}`);
    where += ` AND (${orParts.join(' OR ')})`;
    for (const f of nameFilters) params.push(`%${f}%`);
  }
  const activeRows = (await client.query(
    `SELECT od.id, od.name, od.sigur_department_id, od.kind,
            count(e.id) FILTER (
              WHERE e.is_archived = false
                AND e.excluded_from_timesheet = false
                AND e.employment_status <> 'fired'
            ) AS stuck_employees
       FROM org_departments od
       LEFT JOIN employees e ON e.org_department_id = od.id
      WHERE ${where}
      GROUP BY od.id
      ORDER BY od.kind, od.name`,
    params,
  )).rows;
  console.log(`  всего: ${activeRows.length}`);
  for (const r of activeRows) console.log('  ' + JSON.stringify(r));

  // --- 2. Уже помеченные is_active=false с сигур-биндингом (предыдущие фантомы) ---
  section('2. Уже неактивные отделы с sigur_department_id (предыдущие фантомы)');
  const inactiveRows = (await client.query(
    `SELECT od.id, od.name, od.sigur_department_id, od.kind,
            count(e.id) FILTER (
              WHERE e.is_archived = false
                AND e.excluded_from_timesheet = false
                AND e.employment_status <> 'fired'
            ) AS stuck_employees
       FROM org_departments od
       LEFT JOIN employees e ON e.org_department_id = od.id
      WHERE od.is_active = false AND od.sigur_department_id IS NOT NULL
        ${nameFilters.length > 0 ? 'AND (' + nameFilters.map((_, i) => `od.name ILIKE $${i + 1}`).join(' OR ') + ')' : ''}
      GROUP BY od.id
     HAVING count(e.id) FILTER (
              WHERE e.is_archived = false
                AND e.excluded_from_timesheet = false
                AND e.employment_status <> 'fired'
            ) > 0
      ORDER BY od.name`,
    params,
  )).rows;
  console.log(`  с застрявшими сотрудниками: ${inactiveRows.length}`);
  for (const r of inactiveRows) console.log('  ' + JSON.stringify(r));

  // --- 3. Инструкция оператору ---
  section('Следующий шаг (вручную, не выполняется автоматически)');
  console.log('  1) Сравните список из секции 1 с актуальной выгрузкой Sigur:');
  console.log('     curl -u <user>:<pass> http://<sigur-host>/api/v1/departments | jq -r ".items[].id" | sort -n');
  console.log('  2) Те sigur_department_id, что есть в БД, но НЕТ в выгрузке Sigur, — это фантомы.');
  console.log('  3) Точечный апдейт перед деплоем (пример):');
  console.log("     UPDATE org_departments SET is_active = false WHERE sigur_department_id IN (...);");
  console.log('  4) После деплоя нового кода reconciliation будет помечать фантомы автоматически на каждом тике sync.');
}

const client = new Client({
  connectionString: connStr,
  ssl: { ca, rejectUnauthorized: true },
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});
try {
  await client.connect();
  await run(client);
  await client.end();
  console.log('\nГотово (изменения в БД не вносились).');
  process.exit(0);
} catch (err) {
  console.error(`Ошибка диагностики: ${err?.message ?? err}`);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
}
