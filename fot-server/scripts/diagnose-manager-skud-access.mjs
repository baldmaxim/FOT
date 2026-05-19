// Read-only диагностика: «руководитель получает 403 на
// GET /api/skud/employee-events/:employeeId по конкретному сотруднику».
// Воспроизводит точную логику canAccessEmployeeInScope() и middleware
// requireAnyPageAccess(['/employee','/staff-control'],'view'). Только SELECT-ы,
// БД не изменяется.
//
// Берёт DATABASE_URL из fot-server/.env и CA из .migration/yandex-ca.pem
// (на проде путь к CA в .env — линуксовый, локально не существует, поэтому
// собственный pg.Client с CA из репозитория). Не модифицирует .env.
//
// Usage: node fot-server/scripts/diagnose-manager-skud-access.mjs [email] [employeeId]
//   по умолчанию: alexeykvasov.su10@gmail.com 2517

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const emailArg = (process.argv[2] || 'alexeykvasov.su10@gmail.com').trim();
const employeeIdArg = Number.parseInt(process.argv[3] || '2517', 10);

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
    console.log('!!! ВНИМАНИЕ: host = Supabase-архив (устаревшие данные). Подставьте прод Yandex DATABASE_URL.');
  }
  const rep = await client.query('SELECT pg_is_in_recovery() AS r');
  console.log(`connected (${rep.rows[0].r ? 'replica' : 'PRIMARY'})`);
  console.log(`Руководитель: ${emailArg}; сотрудник: ${employeeIdArg}`);

  // --- 1. Руководитель: app_auth.users -> user_profiles -> system_roles ---
  section('1. Руководитель (auth + profile + роль)');
  const mgr = (await client.query(
    `SELECT au.id AS user_id, au.email,
            up.full_name, up.is_approved, up.employee_id, up.system_role_id,
            sr.code AS role_code, sr.name AS role_name, sr.is_admin
       FROM app_auth.users au
       LEFT JOIN user_profiles up ON up.id = au.id
       LEFT JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE lower(au.email) = lower($1)`,
    [emailArg],
  )).rows[0];
  if (!mgr) { console.log('  НЕ найден в app_auth.users — вход по этому email невозможен. Стоп.'); return; }
  const isAdmin = mgr.is_admin === true;
  console.log(`  user_id=${mgr.user_id} email=${mgr.email}`);
  console.log(`  full_name="${mgr.full_name ?? ''}" is_approved=${mgr.is_approved} employee_id=${mgr.employee_id ?? 'NULL'}`);
  console.log(`  role_code=${mgr.role_code ?? '<нет>'} role_name="${mgr.role_name ?? ''}" is_admin=${isAdmin}`);

  // --- 2. role_page_access (/employee, /staff-control) ---
  section('2. role_page_access (can_view ИЛИ can_edit = эффективный view)');
  let pageView = { '/employee': false, '/staff-control': false };
  if (mgr.role_code) {
    const rpa = (await client.query(
      `SELECT page_path, can_view, can_edit FROM role_page_access
        WHERE role_code = $1 AND page_path = ANY($2::text[])`,
      [mgr.role_code, ['/employee', '/staff-control']],
    )).rows;
    for (const r of rpa) {
      const eff = !!r.can_view || !!r.can_edit;
      pageView[r.page_path] = eff;
      console.log(`  ${r.page_path}: can_view=${r.can_view} can_edit=${r.can_edit} -> effective_view=${eff}`);
    }
    for (const p of ['/employee', '/staff-control']) {
      if (!rpa.some(r => r.page_path === p)) console.log(`  ${p}: <нет строки> -> effective_view=false`);
    }
  } else {
    console.log('  role_code отсутствует — role-based доступ к страницам = false.');
  }

  // --- 3. user_company_access (если is_admin) ---
  section('3. user_company_access (для is_admin)');
  let companyRoots = [];
  if (isAdmin) {
    companyRoots = (await client.query(
      'SELECT company_root_id FROM user_company_access WHERE user_id = $1::uuid',
      [mgr.user_id],
    )).rows.map(r => r.company_root_id);
    console.log(`  roots: ${companyRoots.length === 0 ? 'НЕТ -> системный админ (scope = ALL)' : companyRoots.join(', ')}`);
  } else {
    console.log('  не is_admin — неприменимо.');
  }

  // --- 4. accessible-набор руководителя (как resolveAccessibleDepartmentIds) ---
  section('4. accessible departments руководителя');
  let accessible; // 'all' | string[]
  if (isAdmin && companyRoots.length === 0) {
    accessible = 'all';
    console.log('  = ALL (системный админ).');
  } else if (isAdmin) {
    accessible = (await client.query(
      'SELECT id FROM public.get_descendant_department_ids($1::uuid[])',
      [companyRoots],
    )).rows.map(r => r.id);
    console.log(`  = потомки назначенных корней: ${accessible.length} отделов`);
  } else {
    const rows = (await client.query(
      `SELECT eda.department_id, eda.source, eda.is_active,
              od.name, od.is_active AS dept_active
         FROM employee_department_access eda
         LEFT JOIN org_departments od ON od.id = eda.department_id
        WHERE eda.employee_id = $1
        ORDER BY eda.source, od.name`,
      [mgr.employee_id],
    )).rows;
    console.log(`  Все employee_department_access руководителя (employee_id=${mgr.employee_id ?? 'NULL'}):`);
    for (const r of rows) {
      console.log(`   - "${r.name ?? '?'}" dep=${r.department_id} source=${r.source} acc.is_active=${r.is_active} dept.is_active=${r.dept_active}`);
    }
    accessible = [...new Set(rows
      .filter(r => r.is_active === true && r.source !== 'sigur_sync' && r.department_id)
      .map(r => r.department_id))];
    console.log(`  accessible (is_active && source<>'sigur_sync') = ${accessible.length} отд.: ${accessible.join(', ') || '(пусто)'}`);
  }

  // --- 5. Сотрудник 2517 ---
  section(`5. Сотрудник ${employeeIdArg}`);
  const emp = (await client.query(
    `SELECT e.id, e.full_name, e.org_department_id, e.is_archived,
            e.employment_status, e.excluded_from_timesheet,
            od.name AS dept_name, od.is_active AS dept_active, od.sigur_department_id
       FROM employees e
       LEFT JOIN org_departments od ON od.id = e.org_department_id
      WHERE e.id = $1`,
    [employeeIdArg],
  )).rows[0];
  if (!emp) {
    console.log('  НЕ найден в employees. Стоп (canAccessEmployeeInScope: targetDepartmentIds пуст -> false -> 403).');
    return;
  }
  console.log(`  id=${emp.id} full_name="${emp.full_name ?? ''}" is_archived=${emp.is_archived} employment_status=${emp.employment_status} excluded_from_timesheet=${emp.excluded_from_timesheet}`);
  console.log(`  employees.org_department_id="${emp.dept_name ?? '?'}" id=${emp.org_department_id} dept.is_active=${emp.dept_active} sigur=${emp.sigur_department_id}`);

  const empAccess = (await client.query(
    `SELECT eda.department_id, eda.source, eda.is_active,
            od.name, od.is_active AS dept_active, od.sigur_department_id
       FROM employee_department_access eda
       LEFT JOIN org_departments od ON od.id = eda.department_id
      WHERE eda.employee_id = $1
      ORDER BY eda.is_active DESC, eda.source`,
    [employeeIdArg],
  )).rows;
  console.log(`  employee_department_access сотрудника (${empAccess.length} строк):`);
  for (const r of empAccess) {
    console.log(`   - "${r.name ?? '?'}" dep=${r.department_id} source=${r.source} acc.is_active=${r.is_active} dept.is_active=${r.dept_active} sigur=${r.sigur_department_id}`);
  }
  // loadEmployeeAccessMap: WHERE is_active = true (любой source)
  const targetDeptIds = [...new Set(empAccess
    .filter(r => r.is_active === true && r.department_id)
    .map(r => r.department_id))];
  console.log(`  targetDepartmentIds (acc.is_active=true, любой source) = ${targetDeptIds.length}: ${targetDeptIds.join(', ') || '(пусто)'}`);

  // --- 6. Вердикт canAccessEmployeeInScope ---
  section('6. Вердикт canAccessEmployeeInScope');
  let verdict, reason;
  if (mgr.employee_id != null && Number(mgr.employee_id) === employeeIdArg) {
    verdict = true; reason = 'self-доступ (employee_id руководителя == целевой)';
  } else if (accessible === 'all') {
    verdict = true; reason = 'accessible = ALL';
  } else if (accessible.length === 0) {
    verdict = false; reason = 'accessible пуст (у руководителя нет ручных назначений / company-scope)';
  } else if (targetDeptIds.length === 0) {
    verdict = false; reason = 'у сотрудника нет активных employee_department_access';
  } else {
    const accSet = new Set(accessible);
    const overlap = targetDeptIds.filter(id => accSet.has(id));
    verdict = overlap.length > 0;
    reason = verdict
      ? `пересечение: ${overlap.join(', ')}`
      : 'НЕТ пересечения accessible ∩ targetDepartmentIds';
  }
  console.log(`  -> ${verdict ? 'ДОСТУП ЕСТЬ (200)' : '403 Access denied'} — ${reason}`);

  // middleware requireAnyPageAccess(['/employee','/staff-control'],'view')
  const mwManagerAuto = !isAdmin && accessible !== 'all' && Array.isArray(accessible) && accessible.length > 0;
  const mwPass = isAdmin || pageView['/employee'] || pageView['/staff-control'] || mwManagerAuto;
  console.log(`  middleware requireAnyPageAccess: ${mwPass ? 'ПРОПУСКАЕТ' : '403 Insufficient permissions'}`
    + ` (is_admin=${isAdmin}, view/employee=${pageView['/employee']}, view/staff-control=${pageView['/staff-control']}, managerAuto=${mwManagerAuto})`);

  // --- 7. Dup-check org_departments по именам отделов сотрудника ---
  section('7. Дубли org_departments (правило миграции 106)');
  const names = [...new Set([
    emp.dept_name,
    ...empAccess.map(r => r.name),
  ].filter(Boolean))];
  if (names.length === 0) {
    console.log('  имён отделов у сотрудника нет.');
  }
  const accSet = accessible === 'all' ? null : new Set(accessible);
  for (const name of names) {
    const rows = (await client.query(
      `SELECT id, is_active, sigur_department_id FROM org_departments WHERE name = $1 ORDER BY is_active DESC`,
      [name],
    )).rows;
    const inactiveSigur = rows.filter(r => r.is_active === false && r.sigur_department_id != null);
    const actives = rows.filter(r => r.is_active === true);
    const rule106 = inactiveSigur.length === 1 && actives.length === 1;
    console.log(`  "${name}": строк=${rows.length} (active=${actives.length}, inactive+sigur=${inactiveSigur.length}) -> правило106=${rule106 ? 'ПРИМЕНИМО' : 'нет (неоднозначно/единственная)'}`);
    for (const r of rows) {
      const tags = [];
      if (targetDeptIds.includes(r.id)) tags.push('сотрудник_здесь');
      if (accSet && accSet.has(r.id)) tags.push('руководитель_видит');
      if (accessible === 'all') tags.push('scope=ALL');
      console.log(`     id=${r.id} is_active=${r.is_active} sigur=${r.sigur_department_id}${tags.length ? '  <<< ' + tags.join(', ') : ''}`);
    }
    if (rule106) {
      const orphan = inactiveSigur[0], canon = actives[0];
      const empOnOrphan = targetDeptIds.includes(orphan.id) || emp.org_department_id === orphan.id;
      const mgrOnCanon = accessible === 'all' || (accSet && accSet.has(canon.id));
      if (empOnOrphan && mgrOnCanon) {
        console.log(`     >>> ПРИЧИНА: сотрудник на orphan ${orphan.id}, руководитель видит canonical ${canon.id}. Миграция 106 схлопнет -> 403 уйдёт.`);
      }
    }
  }

  section('ИТОГ');
  if (verdict && mwPass) {
    console.log('canAccessEmployeeInScope=true и middleware пропускает — 403 НЕ воспроизводится этой логикой.');
    console.log('Проверьте: протухший JWT (token_version), кэш scope (10 мин), либо иной слой.');
  } else if (!mwPass) {
    console.log('403 даёт MIDDLEWARE (Insufficient permissions): нет view на /employee и /staff-control И нет manager-auto.');
  } else {
    console.log(`403 даёт ОБРАБОТЧИК (Access denied): ${reason}.`);
    console.log('См. секцию 7: если применимо правило 106 — фикс = миграция 106; иначе ручное назначение/консолидация.');
  }
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
