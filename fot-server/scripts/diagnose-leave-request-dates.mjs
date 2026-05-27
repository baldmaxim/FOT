// Read-only диагностика: «при подаче заявления сохраняется сегодняшняя дата
// вместо выбранной будущей». Смотрим типы колонок leave_requests
// (date vs timestamptz, есть ли DEFAULT/триггер) и последние записи.
//
// Usage: node fot-server/scripts/diagnose-leave-request-dates.mjs [employee_id]

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const employeeIdArg = (process.argv[2] || '').trim();

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
  console.log(`Серверное «сейчас»: ${(await client.query('SELECT NOW() AS now, CURRENT_DATE AS today')).rows[0].now}`);
  console.log(`Серверное CURRENT_DATE: ${(await client.query('SELECT CURRENT_DATE AS today')).rows[0].today}`);

  section('1. Типы колонок leave_requests (start_date / end_date / correction_date)');
  const cols = (await client.query(
    `SELECT column_name, data_type, udt_name, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='leave_requests'
        AND column_name IN ('start_date','end_date','correction_date','created_at','updated_at')
      ORDER BY column_name`,
  )).rows;
  for (const c of cols) {
    console.log(`  ${c.column_name.padEnd(18)} type=${c.data_type} (${c.udt_name})  default=${c.column_default ?? 'NULL'}  nullable=${c.is_nullable}`);
  }

  section('2. Триггеры на leave_requests');
  const trigs = (await client.query(
    `SELECT trigger_name, event_manipulation, action_timing, action_statement
       FROM information_schema.triggers
      WHERE event_object_schema='public' AND event_object_table='leave_requests'`,
  )).rows;
  if (trigs.length === 0) console.log('  Триггеров нет.');
  for (const t of trigs) console.log(`  ${t.trigger_name} ${t.action_timing} ${t.event_manipulation}: ${t.action_statement}`);

  section('3. Последние 10 leave_requests (особенно time_correction)');
  const lr = (await client.query(
    `SELECT id, employee_id, request_type, status,
            start_date::text AS start_date,
            end_date::text AS end_date,
            correction_date::text AS correction_date,
            created_at
       FROM leave_requests
      ${employeeIdArg ? 'WHERE employee_id = $1::int' : ''}
      ORDER BY id DESC LIMIT 10`,
    employeeIdArg ? [employeeIdArg] : [],
  )).rows;
  if (lr.length === 0) console.log('  Записей нет.');
  for (const r of lr) {
    console.log(
      `  id=${r.id} emp=${r.employee_id} ${r.request_type} [${r.status}] ` +
      `start=${r.start_date} end=${r.end_date} correction=${r.correction_date ?? '—'} created=${r.created_at}`,
    );
  }

  section('4. Контрольный pg_typeof «как сервер видит ту же дату»');
  const typecheck = (await client.query(
    `SELECT
       pg_typeof('2026-12-31'::date)        AS t_date,
       '2026-12-31'::date::text             AS as_text,
       to_jsonb('2026-12-31'::date)         AS as_jsonb`,
  )).rows[0];
  console.log(`  date-литерал: type=${typecheck.t_date}  text='${typecheck.as_text}'  jsonb=${JSON.stringify(typecheck.as_jsonb)}`);
} finally {
  await client.end();
}
