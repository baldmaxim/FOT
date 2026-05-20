// Read-only диагностика: «на странице "Управление кадрами" массовое
// назначение графика бригадам не отражается, хотя тост говорит "обновлено N из N"».
// Воспроизводит ровно те SELECT-ы, что использует
//   - bulkApplyToBrigades (controllers/schedule.controller.ts:990) — кого находит
//   - listEmployeeAssignments (там же:828) — кого отдаёт фронту
// Дополнительно: дубли org_departments по правилу миграции 106 и
// застрявшие employee_department_access по правилу миграции 107.
// Только SELECT-ы, БД не изменяется.
//
// Берёт DATABASE_URL из fot-server/.env и CA из .migration/yandex-ca.pem.
// Не модифицирует .env.
//
// Usage:
//   node fot-server/scripts/diagnose-brigade-schedule-assignment.mjs [brigade-search ...]
//   по умолчанию: Курбоншоев Махмадиев

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const searchArgs = process.argv.slice(2);
const brigadeSearches = searchArgs.length > 0 ? searchArgs : ['Курбоншоев', 'Махмадиев'];

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
function table(rows) {
  if (!rows.length) { console.log('  (пусто)'); return; }
  for (const r of rows) console.log('  ' + JSON.stringify(r));
}

async function run(client) {
  console.log(`БД host: ${sanitizedHost}`);
  if (/supabase\.com/i.test(sanitizedHost)) {
    console.log('!!! ВНИМАНИЕ: host = Supabase-архив. Подставьте прод Yandex DATABASE_URL.');
  }
  const rep = await client.query('SELECT pg_is_in_recovery() AS r');
  console.log(`connected (${rep.rows[0].r ? 'replica' : 'PRIMARY'})`);
  console.log(`Поиск бригад по подстрокам: ${brigadeSearches.join(', ')}`);

  const orPatterns = brigadeSearches.map((_, i) => `name ILIKE $${i + 1}`).join(' OR ');
  const ilikeArgs = brigadeSearches.map(s => `%${s}%`);

  // --- 1. org_departments по подстрокам ---
  section('1. org_departments по подстрокам имени');
  const odRows = (await client.query(
    `SELECT id, name, parent_id, kind, is_active, sigur_department_id, created_at
       FROM org_departments
      WHERE ${orPatterns}
      ORDER BY name, is_active DESC, created_at`,
    ilikeArgs,
  )).rows;
  table(odRows);

  const brigadeIds = odRows.filter(r => r.kind === 'brigade').map(r => r.id);
  const allMatchedIds = odRows.map(r => r.id);
  if (brigadeIds.length === 0) {
    console.log('  В org_departments нет бригад под этим поиском. Дальнейшая диагностика бессмысленна.');
    return;
  }

  // --- 2. Сотрудники этих бригад (как видит bulkApplyToBrigades) ---
  // bulkApplyToBrigades делает: employees WHERE org_department_id = ANY(<bridge + дети>)
  //   AND is_archived = false AND excluded_from_timesheet = false
  //   AND employment_status <> 'fired'
  // Тут используем РАСШИРЕННЫЙ набор: бригады + их дочерние отделы (collectDeptIds эквивалент).
  section('2. employees через org_department_id = ANY(brigades + their descendants)');
  // Рекурсивный CTE: потомки.
  const empByOrgRows = (await client.query(
    `WITH RECURSIVE descendants AS (
        SELECT id FROM org_departments WHERE id = ANY($1::uuid[])
        UNION ALL
        SELECT od.id FROM org_departments od JOIN descendants d ON od.parent_id = d.id
      )
      SELECT e.id, e.full_name,
             e.is_archived, e.employment_status, e.excluded_from_timesheet,
             e.org_department_id,
             od.name AS dept_name, od.kind AS dept_kind, od.is_active AS dept_active,
             (SELECT COUNT(*) FROM employee_department_access eda
               WHERE eda.employee_id = e.id AND eda.is_active = true) AS active_membership_count
        FROM employees e
        LEFT JOIN org_departments od ON od.id = e.org_department_id
       WHERE e.org_department_id IN (SELECT id FROM descendants)
       ORDER BY od.name NULLS LAST, e.full_name`,
    [brigadeIds],
  )).rows;
  console.log(`  всего: ${empByOrgRows.length}; активных (не is_archived, не excluded, не fired): ${empByOrgRows.filter(r => !r.is_archived && !r.excluded_from_timesheet && r.employment_status !== 'fired').length}`);
  table(empByOrgRows);

  const activeOrgEmpIds = empByOrgRows
    .filter(r => !r.is_archived && !r.excluded_from_timesheet && r.employment_status !== 'fired')
    .map(r => r.id);

  // --- 3. Те же сотрудники, но через employee_department_access (membership) ---
  section('3. employees через employee_department_access (membership) — другие отделы того же сотрудника');
  const membershipRows = (await client.query(
    `WITH RECURSIVE descendants AS (
        SELECT id FROM org_departments WHERE id = ANY($1::uuid[])
        UNION ALL
        SELECT od.id FROM org_departments od JOIN descendants d ON od.parent_id = d.id
      )
      SELECT eda.employee_id, eda.department_id, eda.source, eda.is_active AS access_active,
             od.name AS dept_name, od.is_active AS dept_active, od.kind AS dept_kind,
             e.full_name, e.org_department_id AS emp_org_dept_id,
             od2.name AS emp_org_dept_name, od2.is_active AS emp_org_dept_active
        FROM employee_department_access eda
        JOIN employees e ON e.id = eda.employee_id
        LEFT JOIN org_departments od ON od.id = eda.department_id
        LEFT JOIN org_departments od2 ON od2.id = e.org_department_id
       WHERE eda.department_id IN (SELECT id FROM descendants)
         AND eda.is_active = true
         AND (e.org_department_id IS DISTINCT FROM eda.department_id)
       ORDER BY e.full_name, eda.source`,
    [brigadeIds],
  )).rows;
  console.log(`  «висит через membership, но org_department_id указывает на другое»: ${membershipRows.length}`);
  table(membershipRows);

  // --- 4. employee_schedule_assignments за последние 7 дней по этим сотрудникам ---
  section('4. employee_schedule_assignments (последние 7 дней) — что реально лежит после bulk-операций');
  let assignRows = [];
  if (activeOrgEmpIds.length > 0) {
    assignRows = (await client.query(
      `SELECT esa.employee_id, e.full_name,
              esa.id AS assignment_id, esa.schedule_id,
              esa.effective_from, esa.effective_to, esa.anchor_date,
              esa.created_by, esa.updated_at,
              ws.name AS schedule_name, ws.is_default
         FROM employee_schedule_assignments esa
         JOIN employees e ON e.id = esa.employee_id
         LEFT JOIN work_schedules ws ON ws.id = esa.schedule_id
        WHERE esa.employee_id = ANY($1::int[])
          AND esa.updated_at > now() - interval '7 days'
        ORDER BY e.full_name, esa.effective_from DESC`,
      [activeOrgEmpIds],
    )).rows;
  }
  console.log(`  записей за 7 дней: ${assignRows.length}`);
  table(assignRows);
  const orphanFk = assignRows.filter(r => r.schedule_name === null);
  if (orphanFk.length > 0) {
    console.log(`  !!! ${orphanFk.length} строк с битым FK на work_schedules (schedule_id указывает на удалённый шаблон)`);
  }

  // --- 5. Снимок listEmployeeAssignments с двумя датами today ---
  section('5. listEmployeeAssignments — что отдаст фронту прямо сейчас (UTC vs Moscow today)');
  const tzRow = (await client.query(
    `SELECT (now() AT TIME ZONE 'UTC')::date AS utc_today,
            (now() AT TIME ZONE 'Europe/Moscow')::date AS msk_today,
            now() AS now_ts`,
  )).rows[0];
  console.log(`  now=${tzRow.now_ts.toISOString()} utc_today=${tzRow.utc_today.toISOString().slice(0,10)} msk_today=${tzRow.msk_today.toISOString().slice(0,10)}`);

  async function snapshot(label, todayDate) {
    if (activeOrgEmpIds.length === 0) { console.log(`  (${label}): нет активных сотрудников`); return []; }
    const rows = (await client.query(
      `SELECT esa.employee_id, e.full_name, esa.schedule_id, ws.name AS schedule_name,
              esa.effective_from, esa.effective_to
         FROM employee_schedule_assignments esa
         JOIN employees e ON e.id = esa.employee_id
         LEFT JOIN work_schedules ws ON ws.id = esa.schedule_id
        WHERE esa.employee_id = ANY($1::int[])
          AND esa.effective_from <= $2
          AND (esa.effective_to IS NULL OR esa.effective_to >= $2)
        ORDER BY esa.employee_id ASC, esa.effective_from DESC`,
      [activeOrgEmpIds, todayDate],
    )).rows;
    console.log(`  --- ${label} (today=${todayDate.toISOString().slice(0,10)}): ${rows.length} строк ---`);
    table(rows);
    return rows;
  }
  const utcSnap = await snapshot('UTC', tzRow.utc_today);
  const mskSnap = await snapshot('Moscow', tzRow.msk_today);

  // Сравнение «первого активного» назначения на сотрудника между UTC и Moscow
  function firstByEmp(rows) {
    const m = new Map();
    for (const r of rows) if (!m.has(r.employee_id)) m.set(r.employee_id, r);
    return m;
  }
  const uMap = firstByEmp(utcSnap);
  const mMap = firstByEmp(mskSnap);
  const allIds = new Set([...uMap.keys(), ...mMap.keys()]);
  const diffs = [];
  for (const id of allIds) {
    const u = uMap.get(id), m = mMap.get(id);
    if ((u && m && u.schedule_id !== m.schedule_id)
        || (u && !m) || (!u && m)) diffs.push({ employee_id: id, utc: u?.schedule_name ?? null, msk: m?.schedule_name ?? null });
  }
  if (diffs.length) {
    console.log(`  !!! Расхождение UTC vs Moscow по ${diffs.length} сотрудникам:`);
    table(diffs);
  } else {
    console.log('  UTC и Moscow дают одно и то же.');
  }

  // --- 6. Анализ дублей org_departments (правило миграции 106) ---
  section('6. Дубли org_departments (правило миграции 106)');
  const groupedNames = [...new Set(odRows.map(r => r.name))];
  for (const name of groupedNames) {
    const sameName = odRows.filter(r => r.name === name);
    const active = sameName.filter(r => r.is_active === true);
    const inactiveSigur = sameName.filter(r => r.is_active === false && r.sigur_department_id != null);
    const rule106 = active.length === 1 && inactiveSigur.length >= 1;
    console.log(`  "${name}": rows=${sameName.length} active=${active.length} inactive+sigur=${inactiveSigur.length} rule106=${rule106 ? 'ПРИМЕНИМО' : 'нет'}`);
    if (rule106) {
      const orphanIds = inactiveSigur.map(r => r.id);
      const canon = active[0];
      const stuck = empByOrgRows.filter(r => orphanIds.includes(r.org_department_id));
      console.log(`    canonical id=${canon.id}; orphans=${orphanIds.length}; сотрудников «застрявших» на orphan: ${stuck.length}`);
      if (stuck.length > 0) {
        console.log('    Список застрявших (попадают в bulkApplyToBrigades только если admin выбрал orphan):');
        table(stuck.map(r => ({ id: r.id, full_name: r.full_name, on_org: r.org_department_id })));
      }
    }
  }

  // --- ВЕРДИКТ ---
  section('ВЕРДИКТ');
  const vrct = [];
  if (empByOrgRows.length === 0) {
    vrct.push('A) employees.org_department_id ни у кого не указывает на эти бригады. bulkApplyToBrigades возвращает employees_matched=0 — пользователь видит "В выбранных бригадах нет активных сотрудников".');
  }
  if (membershipRows.length > 0) {
    vrct.push(`A2) ${membershipRows.length} сотрудников «висят» через employee_department_access на бригаде, но employees.org_department_id указывает на ДРУГОЙ отдел. Это та же ветка A — нужен дедуп бригад по правилу 106 или ручное обновление employees.org_department_id на canonical.`);
  }
  if (diffs.length > 0) {
    vrct.push('B) UTC-vs-Moscow расхождение в listEmployeeAssignments: новое назначение лежит, но при server today=UTC фронт получает старую активную строку. Чиним: считать today в Europe/Moscow.');
  }
  const futureAssigns = assignRows.filter(r => r.effective_from && new Date(r.effective_from) > new Date(tzRow.msk_today));
  if (futureAssigns.length > 0) {
    vrct.push(`C-future) ${futureAssigns.length} назначений с effective_from в БУДУЩЕМ (msk today=${tzRow.msk_today.toISOString().slice(0,10)}). Они не активны сейчас — фронт показывает старое.`);
  }
  const dupAtSameDate = new Map();
  for (const r of assignRows) {
    const key = `${r.employee_id}|${r.effective_from?.toISOString().slice(0,10)}`;
    dupAtSameDate.set(key, (dupAtSameDate.get(key) || 0) + 1);
  }
  const dups = [...dupAtSameDate.entries()].filter(([_, n]) => n > 1);
  if (dups.length > 0) {
    vrct.push(`C-dup) ${dups.length} ситуаций «несколько строк назначений на одну (employee_id, effective_from)». Это нарушение UNIQUE — что-то пошло не так в transactions.`);
  }
  if (orphanFk.length > 0) {
    vrct.push(`D) ${orphanFk.length} строк назначений ссылаются на удалённый work_schedules.id — фронт видит assignment без шаблона и откатывается на default.`);
  }
  if (vrct.length === 0) {
    vrct.push('NONE) данные в порядке. Если жалоба сохраняется — копать в инвалидацию React Query / Service Worker / CDN-кэш.');
  }
  for (const v of vrct) console.log('  - ' + v);
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
