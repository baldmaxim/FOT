// Ретрофикс одобренных заявок на отсутствие (vacation/sick_leave/unpaid):
// раньше при approve() выходные дни диапазона пропускались — в табеле они
// оставались «выходными» вместо «отпуска». Скрипт добавляет в
// attendance_adjustments недостающие записи на Сб/Вс по уже одобренным заявкам.
//
// Идемпотентен: UNIQUE (employee_id, work_date, source_type, source_id) +
// ON CONFLICT DO NOTHING. Повторный прогон даёт 0 вставок.
//
// Usage:
//   node fot-server/scripts/backfill-vacation-weekends.mjs --dry-run
//   node fot-server/scripts/backfill-vacation-weekends.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const LEAVE_TO_TIMESHEET = {
  vacation: 'vacation',
  sick_leave: 'sick',
  unpaid: 'unpaid',
};

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

const client = new Client({
  connectionString: connStr,
  ssl: { ca, rejectUnauthorized: true },
});

await client.connect();
console.log(`БД: ${sanitizedHost}`);
console.log(`Режим: ${dryRun ? 'DRY-RUN (без INSERT)' : 'APPLY (с INSERT)'}`);

const requests = (await client.query(
  `SELECT id, employee_id, request_type, reviewer_id,
          start_date::text AS start_date,
          end_date::text   AS end_date
     FROM leave_requests
    WHERE status = 'approved'
      AND request_type = ANY($1::text[])
    ORDER BY id`,
  [Object.keys(LEAVE_TO_TIMESHEET)],
)).rows;

console.log(`\nКандидатов (approved vacation/sick_leave/unpaid): ${requests.length}`);

let totalWeekendCells = 0;
let totalAlreadyExist = 0;
let totalInserted = 0;
let requestsTouched = 0;

for (const r of requests) {
  const status = LEAVE_TO_TIMESHEET[r.request_type];
  const sourceId = String(r.id);

  if (dryRun) {
    const missing = (await client.query(
      `SELECT d::date::text AS work_date
         FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS d
        WHERE EXTRACT(DOW FROM d) IN (0, 6)
          AND NOT EXISTS (
            SELECT 1 FROM attendance_adjustments
             WHERE employee_id = $3::int
               AND work_date = d::date
               AND source_type = 'leave_request'
               AND source_id = $4::text
          )`,
      [r.start_date, r.end_date, r.employee_id, sourceId],
    )).rows;

    const allWeekends = (await client.query(
      `SELECT COUNT(*)::int AS n
         FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS d
        WHERE EXTRACT(DOW FROM d) IN (0, 6)`,
      [r.start_date, r.end_date],
    )).rows[0].n;

    totalWeekendCells += allWeekends;
    totalAlreadyExist += allWeekends - missing.length;
    totalInserted += missing.length;
    if (missing.length > 0) {
      requestsTouched += 1;
      console.log(
        `  [DRY] req#${r.id} emp=${r.employee_id} ${r.request_type} ` +
        `${r.start_date}..${r.end_date}: добавилось бы ${missing.length} ` +
        `(${missing.map(m => m.work_date).join(', ')})`,
      );
    }
  } else {
    const inserted = (await client.query(
      `INSERT INTO attendance_adjustments (
         employee_id, work_date, status, hours_override,
         source_type, source_id, reason, created_by
       )
       SELECT
         $1::int,
         d::date,
         $2::text,
         NULL,
         'leave_request',
         $3::text,
         'Backfill vacation/sick/unpaid weekends',
         $4::uuid
       FROM generate_series($5::date, $6::date, INTERVAL '1 day') AS d
       WHERE EXTRACT(DOW FROM d) IN (0, 6)
       ON CONFLICT (employee_id, work_date, source_type, source_id) DO NOTHING
       RETURNING id, work_date::text AS work_date`,
      [r.employee_id, status, sourceId, r.reviewer_id, r.start_date, r.end_date],
    )).rows;

    const allWeekends = (await client.query(
      `SELECT COUNT(*)::int AS n
         FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS d
        WHERE EXTRACT(DOW FROM d) IN (0, 6)`,
      [r.start_date, r.end_date],
    )).rows[0].n;

    totalWeekendCells += allWeekends;
    totalInserted += inserted.length;
    totalAlreadyExist += allWeekends - inserted.length;
    if (inserted.length > 0) {
      requestsTouched += 1;
      console.log(
        `  [INS] req#${r.id} emp=${r.employee_id} ${r.request_type} ` +
        `${r.start_date}..${r.end_date}: +${inserted.length} ` +
        `(${inserted.map(m => m.work_date).join(', ')})`,
      );
    }
  }
}

console.log('\n=== ИТОГ ===');
console.log(`  Заявок-кандидатов:               ${requests.length}`);
console.log(`  Заявок, к которым нужно дописать: ${requestsTouched}`);
console.log(`  Выходных дней в диапазонах:      ${totalWeekendCells}`);
console.log(`  Уже было в attendance_adj:       ${totalAlreadyExist}`);
console.log(`  ${dryRun ? 'Будет вставлено' : 'Вставлено'}:                  ${totalInserted}`);

await client.end();
