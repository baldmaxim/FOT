// Read-only диагностика: «руководитель получает 403 на действия с отделом
// (загрузка вложения, travel-segments и т.п.)». Симулирует логику
// resolveAccessibleDepartmentIds() + новый subtree-fallback для не-админов.
//
// Берёт DATABASE_URL из fot-server/.env и CA из .migration/yandex-ca.pem.
// Только SELECT — БД не изменяется.
//
// Usage:
//   node fot-server/scripts/diagnose-manager-dept-access.mjs [email] [departmentId?]
// Примеры:
//   node fot-server/scripts/diagnose-manager-dept-access.mjs manager@example.com
//   node fot-server/scripts/diagnose-manager-dept-access.mjs manager@example.com 8b1f...

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const emailArg = (process.argv[2] || '').trim();
const requestedDeptArg = (process.argv[3] || '').trim() || null;

if (!emailArg) {
  console.error('Usage: node fot-server/scripts/diagnose-manager-dept-access.mjs <email> [departmentId?]');
  process.exit(2);
}

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
  const rep = await client.query('SELECT pg_is_in_recovery() AS r');
  console.log(`connected (${rep.rows[0].r ? 'replica' : 'PRIMARY'})`);
  console.log(`Руководитель: ${emailArg}` + (requestedDeptArg ? `; departmentId=${requestedDeptArg}` : ''));

  // --- 1. Пользователь ---
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
  if (!mgr) { console.log('  НЕ найден в app_auth.users.'); return; }
  const isAdmin = mgr.is_admin === true;
  console.log(`  user_id=${mgr.user_id} role_code=${mgr.role_code ?? '<нет>'} is_admin=${isAdmin}`);
  console.log(`  full_name="${mgr.full_name ?? ''}" employee_id=${mgr.employee_id ?? 'NULL'}`);

  // --- 2. Явный список отделов (employee_department_access) ---
  section('2. employee_department_access руководителя');
  const allRows = (await client.query(
    `SELECT eda.department_id, eda.source, eda.is_active,
            od.name, od.is_active AS dept_active
       FROM employee_department_access eda
       LEFT JOIN org_departments od ON od.id = eda.department_id
      WHERE eda.employee_id = $1
      ORDER BY eda.source, od.name`,
    [mgr.employee_id],
  )).rows;
  for (const r of allRows) {
    console.log(`  - "${r.name ?? '?'}" dep=${r.department_id} source=${r.source} acc.is_active=${r.is_active} dept.is_active=${r.dept_active}`);
  }
  // listExplicitDepartmentIdsForUser: WHERE is_active = true AND source <> 'sigur_sync'
  const explicit = [...new Set(allRows
    .filter(r => r.is_active === true && r.source !== 'sigur_sync' && r.department_id)
    .map(r => r.department_id))];
  console.log(`  explicit (is_active && source<>'sigur_sync') = ${explicit.length}: ${explicit.join(', ') || '(пусто)'}`);

  // --- 3. Поддерево (новый subtree-fallback) ---
  section('3. Subtree от explicit (RPC get_descendant_department_ids)');
  let subtreeIds = [];
  if (explicit.length === 0) {
    console.log('  пусто — у руководителя нет explicit-строк; subtree не считается.');
  } else {
    subtreeIds = (await client.query(
      'SELECT id FROM public.get_descendant_department_ids($1::uuid[])',
      [explicit],
    )).rows.map(r => r.id);
    const onlyDescendants = subtreeIds.filter(id => !explicit.includes(id));
    console.log(`  subtree всего: ${subtreeIds.length} (новые потомки: ${onlyDescendants.length})`);
    if (onlyDescendants.length > 0) {
      const names = (await client.query(
        `SELECT id, name, is_active FROM org_departments WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [onlyDescendants],
      )).rows;
      for (const r of names) {
        console.log(`    + "${r.name ?? '?'}" ${r.id} is_active=${r.is_active}`);
      }
    }
  }

  // accessible = explicit ∪ subtree
  const accessible = isAdmin
    ? null
    : [...new Set([...explicit, ...subtreeIds])];

  // --- 4. Проверка конкретного departmentId ---
  if (requestedDeptArg) {
    section(`4. Проверка departmentId=${requestedDeptArg}`);
    const meta = (await client.query(
      'SELECT id, name, is_active, parent_department_id FROM org_departments WHERE id = $1',
      [requestedDeptArg],
    )).rows[0];
    if (!meta) {
      console.log('  отдел не найден в org_departments.');
    } else {
      console.log(`  "${meta.name ?? '?'}" is_active=${meta.is_active} parent=${meta.parent_department_id}`);
      if (isAdmin) {
        console.log('  is_admin=true — доступ открыт.');
      } else {
        const inExplicit = explicit.includes(requestedDeptArg);
        const inSubtree = subtreeIds.includes(requestedDeptArg);
        console.log(`  в explicit: ${inExplicit}`);
        console.log(`  в subtree:  ${inSubtree}`);
        if (inExplicit) console.log('  -> ДОСТУП (через явное назначение, работает и без фикса).');
        else if (inSubtree) console.log('  -> ДОСТУП (через subtree-fallback, требует нового кода в data-scope.service.ts).');
        else console.log('  -> 403 (не в дереве). Нужно явное назначение через миграцию 107 / админ-UI.');
      }
    }
  } else {
    section('4. (departmentId не указан — пропускаю точечную проверку)');
    console.log('  передайте departmentId 2-м аргументом, чтобы проверить конкретный отдел.');
  }

  // --- 5. Сводка ---
  section('ИТОГ');
  if (isAdmin) {
    console.log('is_admin=true: scope считается через user_company_access, не через employee_department_access.');
  } else if (explicit.length === 0) {
    console.log('explicit = пусто — руководитель видит только /employee/*. Нужны записи в employee_department_access.');
  } else {
    console.log(`До фикса: доступно ${explicit.length} отд. После subtree-fallback: ${accessible.length} отд.`);
    if (accessible.length > explicit.length) {
      console.log(`Прирост: +${accessible.length - explicit.length} sub-департаментов через RPC поддерева.`);
    }
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
