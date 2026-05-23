// Read-only диагностика: почему миграция 124 не подняла записи в очередь
// «Согласование выходных дней» за конкретную дату.
//
// Показывает:
// 1) Whitelist отделов (что реально сейчас в system_settings + дефолт).
// 2) Все attendance_adjustments на указанную дату с расшифровкой
//    «попадает ли под условия миграции 124» (status/source_type/approval/DOW/dept/hours).
// 3) leave_requests на эту дату — есть ли вообще такие заявления.
//
// Usage: node fot-server/scripts/diagnose-correction-approval-backfill.mjs [YYYY-MM-DD]

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const dateArg = (process.argv[2] || '').trim() || '2026-05-23';
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error(`Bad date: ${dateArg}. Use YYYY-MM-DD.`);
  process.exit(2);
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
const dbUrl = env.DATABASE_URL;
if (!dbUrl) { console.error('Missing DATABASE_URL'); process.exit(2); }
const ca = fs.readFileSync(CA_PATH, 'utf8');

let connStr = dbUrl;
let host = '<unknown>';
try {
  const u = new URL(dbUrl);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(p);
  connStr = u.toString();
  host = `${u.hostname}:${u.port || '5432'} / db=${u.pathname.replace(/^\//, '')}`;
} catch {}

function section(t) { console.log(`\n=== ${t} ===`); }

const client = new Client({ connectionString: connStr, ssl: { ca, rejectUnauthorized: true } });

try {
  await client.connect();
  console.log(`БД host: ${host}`);
  console.log(`Дата проверки: ${dateArg}  (DOW=${new Date(`${dateArg}T00:00:00Z`).getUTCDay()})`);

  section('1. Whitelist отделов из system_settings');
  const wlRaw = (await client.query(
    `SELECT value, updated_at, updated_by
       FROM system_settings
      WHERE key = 'correction_approval_required_department_ids'`,
  )).rows[0];
  if (!wlRaw) {
    console.log('  Ключ correction_approval_required_department_ids НЕ задан → дефолт = все kind=\'department\'.');
  } else {
    const v = wlRaw.value;
    console.log(`  Значение: ${v == null ? 'NULL' : (v.length > 200 ? v.slice(0, 200) + '…' : v)}`);
    console.log(`  updated_at=${wlRaw.updated_at}  updated_by=${wlRaw.updated_by ?? '—'}`);
    if (v && v.trim() !== '' && v.trim() !== '[]') {
      try {
        const arr = JSON.parse(v);
        console.log(`  Парсится как массив длиной ${Array.isArray(arr) ? arr.length : '???'}`);
      } catch (e) { console.log(`  ! НЕ парсится как JSON: ${e.message}`); }
    } else {
      console.log('  Пустое/[] → миграция 124 уходит на дефолт «все kind=department».');
    }
  }

  section('2. Размер эффективного whitelist (как видит миграция 124)');
  const wlSize = (await client.query(`
    WITH setting AS (
      SELECT value FROM system_settings
       WHERE key = 'correction_approval_required_department_ids'
    ),
    whitelist AS (
      SELECT jsonb_array_elements_text(value::jsonb) AS dept_id
        FROM setting
       WHERE value IS NOT NULL AND TRIM(value) <> '' AND value::jsonb <> '[]'::jsonb
      UNION
      SELECT id::text FROM org_departments
       WHERE kind = 'department'
         AND NOT EXISTS (
           SELECT 1 FROM setting
            WHERE value IS NOT NULL AND TRIM(value) <> '' AND value::jsonb <> '[]'::jsonb
         )
    )
    SELECT COUNT(*) AS n FROM whitelist
  `)).rows[0];
  console.log(`  Кол-во UUID в эффективном whitelist: ${wlSize.n}`);

  section(`3. attendance_adjustments на ${dateArg}`);
  const adj = (await client.query(
    `SELECT aa.id, aa.employee_id, aa.work_date::text AS work_date, aa.status,
            aa.hours_override, aa.approval_status, aa.source_type, aa.source_id,
            aa.created_at, aa.created_by,
            e.full_name, e.org_department_id::text AS dept_id,
            d.name AS dept_name, d.kind AS dept_kind
       FROM attendance_adjustments aa
       LEFT JOIN employees e ON e.id = aa.employee_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE aa.work_date = $1::date
      ORDER BY aa.id DESC`,
    [dateArg],
  )).rows;
  if (adj.length === 0) {
    console.log(`  На ${dateArg} в attendance_adjustments вообще нет записей. Возможно, руководитель отметил часы через timesheet UI без создания adjustment, либо запись на другую дату.`);
  } else {
    console.log(`  Найдено ${adj.length} записей. Проверка каждой по условиям миграции 124:`);
    for (const r of adj) {
      const checks = [];
      checks.push(`status=${r.status}${['work','remote'].includes(r.status) ? '✓' : '✗(нужно work/remote)'}`);
      checks.push(`source_type=${r.source_type}${r.source_type === 'leave_request' ? '✓' : '✗(нужно leave_request)'}`);
      checks.push(`approval_status=${r.approval_status}${r.approval_status === 'auto_approved' ? '✓' : '✗(уже не auto_approved)'}`);
      const h = r.hours_override == null ? null : Number(r.hours_override);
      checks.push(`hours_override=${h}${h !== 0 ? '✓' : '✗(=0)'}`);
      checks.push(`dept_kind=${r.dept_kind ?? '—'}`);
      console.log(`  ─ adj.id=${r.id} emp=${r.employee_id} ${r.full_name ?? '?'} dept=${r.dept_name ?? '?'} (${r.dept_id ?? '—'})`);
      console.log(`     ${checks.join('  ')}`);
      console.log(`     source_id=${r.source_id ?? '—'}  created_at=${r.created_at}  created_by=${r.created_by ?? '—'}`);

      // Проверка whitelist для этой записи (если dept есть)
      if (r.dept_id) {
        const inWl = (await client.query(`
          WITH setting AS (
            SELECT value FROM system_settings
             WHERE key = 'correction_approval_required_department_ids'
          ),
          whitelist AS (
            SELECT jsonb_array_elements_text(value::jsonb) AS dept_id
              FROM setting
             WHERE value IS NOT NULL AND TRIM(value) <> '' AND value::jsonb <> '[]'::jsonb
            UNION
            SELECT id::text FROM org_departments
             WHERE kind = 'department'
               AND NOT EXISTS (
                 SELECT 1 FROM setting
                  WHERE value IS NOT NULL AND TRIM(value) <> '' AND value::jsonb <> '[]'::jsonb
               )
          )
          SELECT 1 FROM whitelist WHERE dept_id = $1::text LIMIT 1
        `, [r.dept_id])).rowCount > 0;
        console.log(`     отдел в whitelist? ${inWl ? '✓ да' : '✗ нет'}`);
      }
    }
  }

  section(`4. leave_requests c участием даты ${dateArg}`);
  const lr = (await client.query(
    `SELECT id, employee_id, request_type, status,
            start_date::text AS start_date, end_date::text AS end_date,
            correction_date::text AS correction_date,
            reviewer_id, reviewed_at, created_at
       FROM leave_requests
      WHERE (start_date <= $1::date AND end_date >= $1::date)
         OR correction_date = $1::date
      ORDER BY id DESC LIMIT 20`,
    [dateArg],
  )).rows;
  if (lr.length === 0) {
    console.log('  Заявлений, охватывающих эту дату, нет.');
  } else {
    for (const r of lr) {
      console.log(`  lr.id=${r.id} emp=${r.employee_id} ${r.request_type} [${r.status}] start=${r.start_date} end=${r.end_date} correction=${r.correction_date ?? '—'} reviewed=${r.reviewed_at ?? '—'}`);
    }
  }
} finally {
  await client.end();
}
