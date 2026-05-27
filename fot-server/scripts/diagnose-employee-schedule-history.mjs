// Read-only диагностика: «не меняется дата назначения графика, сервер говорит
// «уже существует»». Смотрим employee_schedule_assignments для сотрудников
// УОК_2 (Габараева, Корж, Миоков, Узун Федор) — есть ли стейл-исторические
// записи, которые блокируют операцию.
//
// Usage:
//   node fot-server/scripts/diagnose-employee-schedule-history.mjs
//   node fot-server/scripts/diagnose-employee-schedule-history.mjs "УОК_2"
//   node fot-server/scripts/diagnose-employee-schedule-history.mjs "Габараева|Корж"

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const DEFAULT_NAME_PATTERN = 'Габараева|Корж|Миоков|Узун';
const arg = (process.argv[2] || '').trim();

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

// Если аргумент похож на название отдела (без вертикальной черты и без
// кириллических ФИО-разделителей) — фильтруем сотрудников по отделу. Иначе —
// regex по full_name.
const looksLikeDepartmentName = arg && !arg.includes('|') && !/(^|[^а-я])[А-Я][а-я]+$/.test(arg);
const namePattern = looksLikeDepartmentName ? null : (arg || DEFAULT_NAME_PATTERN);
const departmentName = looksLikeDepartmentName ? arg : null;

try {
  await client.connect();
  console.log(`БД host: ${sanitizedHost}`);
  console.log(`Серверное CURRENT_DATE: ${(await client.query('SELECT CURRENT_DATE AS today')).rows[0].today}`);
  console.log(`Фильтр сотрудников: ${departmentName ? `отдел "${departmentName}"` : `full_name ~ '${namePattern}'`}`);

  section('1. Сотрудники, попавшие в выборку');
  const empRows = (await client.query(
    departmentName
      ? `SELECT e.id, e.full_name, d.name AS department_name
           FROM employees e
           LEFT JOIN org_departments d ON d.id = e.org_department_id
          WHERE d.name = $1
            AND e.is_archived = false
            AND e.employment_status <> 'fired'
          ORDER BY e.full_name`
      : `SELECT e.id, e.full_name, d.name AS department_name
           FROM employees e
           LEFT JOIN org_departments d ON d.id = e.org_department_id
          WHERE e.full_name ~ $1
            AND e.is_archived = false
            AND e.employment_status <> 'fired'
          ORDER BY e.full_name`,
    [departmentName || namePattern],
  )).rows;

  if (empRows.length === 0) {
    console.log('  Сотрудники не найдены.');
    process.exit(0);
  }
  for (const r of empRows) {
    console.log(`  #${r.id}  ${r.full_name}   [${r.department_name || 'нет отдела'}]`);
  }
  const employeeIds = empRows.map(r => r.id);

  section('2. Все строки employee_schedule_assignments (история целиком)');
  const assignments = (await client.query(
    `SELECT a.id, a.employee_id, e.full_name, ws.name AS schedule_name,
            a.schedule_id, a.effective_from, a.effective_to,
            a.anchor_date, a.created_at, a.updated_at
       FROM employee_schedule_assignments a
       LEFT JOIN employees e ON e.id = a.employee_id
       LEFT JOIN work_schedules ws ON ws.id = a.schedule_id
      WHERE a.employee_id = ANY($1::int[])
      ORDER BY a.employee_id, a.effective_from`,
    [employeeIds],
  )).rows;

  if (assignments.length === 0) {
    console.log('  У этих сотрудников нет персональных назначений (используется график по умолчанию).');
  } else {
    let lastEmp = null;
    for (const a of assignments) {
      if (a.employee_id !== lastEmp) {
        console.log(`\n  --- #${a.employee_id} ${a.full_name} ---`);
        lastEmp = a.employee_id;
      }
      const eto = a.effective_to ? `по ${a.effective_to.toISOString().slice(0, 10)}` : 'открыто';
      const efrom = a.effective_from.toISOString().slice(0, 10);
      const anchor = a.anchor_date ? `  anchor=${a.anchor_date.toISOString().slice(0, 10)}` : '';
      console.log(`    ${a.id}  c ${efrom} ${eto}  «${a.schedule_name}»${anchor}`);
    }
  }

  section('3. Подозрительные стейл-записи (effective_to < CURRENT_DATE), которые могут блокировать UI');
  const stale = assignments.filter(a => a.effective_to && a.effective_to < new Date());
  if (stale.length === 0) {
    console.log('  Стейл-фрагментов не найдено.');
  } else {
    for (const a of stale) {
      const efrom = a.effective_from.toISOString().slice(0, 10);
      const eto = a.effective_to.toISOString().slice(0, 10);
      console.log(`  emp #${a.employee_id} ${a.full_name}: ${a.id} «${a.schedule_name}» c ${efrom} по ${eto}`);
    }
  }

  section('4. Дубликаты effective_from в рамках одного сотрудника');
  const byKey = new Map();
  for (const a of assignments) {
    const k = `${a.employee_id}|${a.effective_from.toISOString().slice(0, 10)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(a);
  }
  let dupFound = false;
  for (const [k, rows] of byKey) {
    if (rows.length > 1) {
      dupFound = true;
      console.log(`  ${k}: ${rows.length} строк (это уже невозможно при UNIQUE, репортите как баг БД).`);
    }
  }
  if (!dupFound) console.log('  Дубликатов нет (UNIQUE constraint работает).');
} finally {
  await client.end();
}
