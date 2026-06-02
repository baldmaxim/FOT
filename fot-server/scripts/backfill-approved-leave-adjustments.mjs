// Ретрофикс: одобренные заявки (leave_requests.status='approved') без строк в
// attendance_adjustments. Из-за неатомарного approve() (статус ставился ДО создания
// корректировок и вне транзакции) часть согласованных заявок осталась без отметок в
// табеле — день рисуется по графику/СКУД вместо «Удалёнка»/«Отпуск»/«Работа». Также
// одиночные remote-заявки на выходной молча отбрасывались (skipWeekends).
//
// Скрипт материализует недостающие attendance_adjustments по той же логике, что approve():
//   - типы remote/vacation/sick_leave/unpaid/work/dayoff/educational_leave;
//   - даты берём из selected_dates (дискретные), иначе из диапазона start..end;
//   - выходные пропускаем ТОЛЬКО для многодневного remote-диапазона (start<>end);
//   - даты читаются и разворачиваются в SQL → независимость от TZ pg-клиента;
//   - hours_override=NULL, source_type='leave_request', source_id=lr.id,
//     reason=lr.reason, created_by=автор (user_profiles по employee_id, иначе reviewer),
//     approval_status='auto_approved' (= default; для work approve() ставит его явно).
//
// Идемпотентен: UNIQUE (employee_id, work_date, source_type, source_id) +
// ON CONFLICT DO NOTHING. Повторный прогон даёт 0 вставок.
//
// Usage:
//   node fot-server/scripts/backfill-approved-leave-adjustments.mjs --dry-run
//   node fot-server/scripts/backfill-approved-leave-adjustments.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

// request_type → TimeStatus (зеркало LEAVE_TO_TIMESHEET в leave-requests.controller.ts).
const LEAVE_TO_TIMESHEET = {
  remote: 'remote',
  vacation: 'vacation',
  sick_leave: 'sick',
  unpaid: 'unpaid',
  work: 'work',
  dayoff: 'dayoff',
  educational_leave: 'educational_leave',
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

// Кандидаты: одобренные заявки материализуемых типов без единой leave_request-строки.
// Даты — строками (TZ-безопасно). Автор — user_profiles по employee_id, иначе reviewer.
const requests = (await client.query(
  `SELECT lr.id,
          lr.employee_id,
          lr.request_type,
          lr.reason,
          lr.start_date::text AS start_date,
          lr.end_date::text   AS end_date,
          (lr.selected_dates IS NOT NULL AND array_length(lr.selected_dates, 1) > 0) AS has_discrete,
          (lr.start_date = lr.end_date) AS is_single_day,
          (SELECT up.id FROM user_profiles up WHERE up.employee_id = lr.employee_id LIMIT 1) AS author_id,
          lr.reviewer_id
     FROM leave_requests lr
    WHERE lr.status = 'approved'
      AND lr.request_type = ANY($1::text[])
      AND NOT EXISTS (
            SELECT 1 FROM attendance_adjustments aa
             WHERE aa.source_type = 'leave_request'
               AND aa.source_id = lr.id::text
          )
    ORDER BY lr.id`,
  [Object.keys(LEAVE_TO_TIMESHEET)],
)).rows;

console.log(`\nКандидатов (approved без корректировок): ${requests.length}`);

// SQL разворачивания дат заявки в набор work_date (дискретные | диапазон с учётом выходных).
// $1 has_discrete, $2 selected_dates(date[]), $3 start, $4 end, $5 skip_weekends.
const CANDIDATE_DATES_SQL = `
  SELECT wd FROM (
    SELECT d::date AS wd FROM unnest($2::date[]) d WHERE $1::boolean
    UNION ALL
    SELECT gs::date AS wd
      FROM generate_series($3::date, $4::date, INTERVAL '1 day') gs
     WHERE NOT $1::boolean
       AND NOT ($5::boolean AND EXTRACT(DOW FROM gs) IN (0, 6))
  ) c
  ORDER BY wd
`;

let totalInserted = 0;
let totalAlreadyExist = 0;
let requestsTouched = 0;
const perType = {};

for (const r of requests) {
  const status = LEAVE_TO_TIMESHEET[r.request_type];
  const sourceId = String(r.id);
  const createdBy = r.author_id ?? r.reviewer_id ?? null;
  // skipWeekends только для многодневного remote-диапазона; дискретные и одиночные дни — всегда.
  const skipWeekends = r.request_type === 'remote' && !r.has_discrete && !r.is_single_day;
  // selected_dates приходит как Date[] (свой pg-клиент без type-override) — в SQL передаём
  // как text[], приведение ::date[] нормализует к чистым датам.
  const selected = r.has_discrete
    ? (await client.query(
        `SELECT ARRAY(SELECT d::text FROM unnest(selected_dates) d) AS dates FROM leave_requests WHERE id = $1`,
        [r.id],
      )).rows[0].dates
    : [];

  if (dryRun) {
    const dates = (await client.query(
      `SELECT cand.wd::text AS work_date
         FROM (${CANDIDATE_DATES_SQL}) cand
        WHERE NOT EXISTS (
            SELECT 1 FROM attendance_adjustments aa
             WHERE aa.employee_id = $6::int
               AND aa.work_date = cand.wd
               AND aa.source_type = 'leave_request'
               AND aa.source_id = $7::text
          )`,
      [r.has_discrete, selected, r.start_date, r.end_date, skipWeekends, r.employee_id, sourceId],
    )).rows;
    if (dates.length > 0) {
      requestsTouched += 1;
      totalInserted += dates.length;
      perType[r.request_type] = (perType[r.request_type] ?? 0) + dates.length;
      console.log(
        `  [DRY] req#${r.id} emp=${r.employee_id} ${r.request_type} → +${dates.length} ` +
        `(${dates.map(d => d.work_date).join(', ')})`,
      );
    }
  } else {
    const inserted = (await client.query(
      `INSERT INTO attendance_adjustments
         (employee_id, work_date, status, hours_override, source_type, source_id,
          reason, created_by, approval_status)
       SELECT $6::int, cand.wd, $8::text, NULL, 'leave_request', $7::text,
              $9::text, $10::uuid, 'auto_approved'
         FROM (${CANDIDATE_DATES_SQL}) cand
       ON CONFLICT (employee_id, work_date, source_type, source_id) DO NOTHING
       RETURNING work_date::text AS work_date`,
      [r.has_discrete, selected, r.start_date, r.end_date, skipWeekends,
       r.employee_id, sourceId, status, r.reason ?? null, createdBy],
    )).rows;
    if (inserted.length > 0) {
      requestsTouched += 1;
      totalInserted += inserted.length;
      perType[r.request_type] = (perType[r.request_type] ?? 0) + inserted.length;
      console.log(
        `  [INS] req#${r.id} emp=${r.employee_id} ${r.request_type} → +${inserted.length} ` +
        `(${inserted.map(d => d.work_date).join(', ')})`,
      );
    } else {
      totalAlreadyExist += 1;
    }
  }
}

console.log('\n=== ИТОГ ===');
console.log(`  Заявок-кандидатов:         ${requests.length}`);
console.log(`  Заявок, к которым дописали: ${requestsTouched}`);
console.log(`  ${dryRun ? 'Будет вставлено дней' : 'Вставлено дней'}:       ${totalInserted}`);
for (const [type, n] of Object.entries(perType)) {
  console.log(`      ${type}: ${n}`);
}
if (!dryRun) console.log(`  Заявок без новых дней:      ${totalAlreadyExist}`);

await client.end();
