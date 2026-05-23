// Read-only диагностика: «одобренный пользователь видит "Ожидание одобрения"
// при входе». Только SELECT-ы, БД не изменяется.
//
// Берёт DATABASE_URL из fot-server/.env и CA из .migration/yandex-ca.pem
// (на проде путь к CA в .env — линуксовый, локально не существует, поэтому
// собственный pg.Client с CA из репозитория). Не модифицирует .env.
//
// Usage: node fot-server/scripts/diagnose-user-approval.mjs [email] [surname]
//   email   — по умолчанию: shadrov.s.i@mstroy.pro
//   surname — необязательный шаблон фамилии для поиска по ФИО (user_profiles.
//             full_name — кириллица; латинский токен из email её не матчит).
//             Пример: node ... diagnose-user-approval.mjs arkhipov.x@mstroy.pro Архипов

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const emailArg = (process.argv[2] || 'shadrov.s.i@mstroy.pro').trim();
const surnameArg = (process.argv[3] || '').trim();
const surnameToken = (emailArg.split('@')[0] || emailArg).split('.')[0] || emailArg;
const likeLocal = `%${surnameToken}%`;

// Шаблоны для поиска по ФИО (user_profiles.full_name). Латинский токен из email
// не матчит кириллические ФИО — поэтому surname-аргумент (если передан).
const profileNamePatterns = [...new Set([
  likeLocal,
  surnameArg ? `%${surnameArg}%` : null,
].filter(Boolean))];

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

// Из строки подключения убираем ssl*-параметры: pg-connection-string при
// создании Client делает readFileSync(sslrootcert) — это линуксовый путь
// прода, локально его нет. CA подаём явно через опцию ssl ниже.
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

async function runDiagnostics(client) {
  console.log(`БД host: ${sanitizedHost}`);
  console.log(`Диагностика для: ${emailArg} (surname-token: "${surnameToken}"`
    + `${surnameArg ? `, surname-arg: "${surnameArg}"` : ''})`);

  const roles = (await client.query('SELECT id, code, name FROM system_roles')).rows;
  const roleById = new Map(roles.map(r => [r.id, `${r.code}${r.name ? ` (${r.name})` : ''}`]));
  const roleLabel = id => (id ? (roleById.get(id) ?? `<неизв. роль ${id}>`) : '<нет>');

  section('1. app_auth.users (по email и фамилии)');
  const auth = (await client.query(
    `SELECT id, email, email_confirmed_at, created_at
       FROM app_auth.users
      WHERE lower(email) = lower($1) OR lower(email) LIKE lower($2)
      ORDER BY created_at`,
    [emailArg, likeLocal],
  )).rows;
  if (auth.length === 0) {
    console.log('  Ничего — пользователь с таким email/фамилией в app_auth.users отсутствует.');
  } else {
    for (const r of auth) {
      console.log(`  id=${r.id} email=${r.email} email_confirmed_at=${r.email_confirmed_at ?? 'NULL (НЕ подтверждён)'} created_at=${r.created_at}`);
    }
  }

  section('2. user_profiles по найденным auth-id (строки, по которым идёт вход)');
  const authIds = auth.map(r => r.id);
  let authProfiles = [];
  if (authIds.length > 0) {
    authProfiles = (await client.query(
      `SELECT id, full_name, is_approved, approved_at, approved_by,
              system_role_id, employee_id, two_factor_enabled, created_at
         FROM user_profiles WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [authIds],
    )).rows;
    if (authProfiles.length === 0) {
      console.log('  ВНИМАНИЕ: для auth-пользователя НЕТ строки user_profiles ("User profile not found" при входе).');
    }
    for (const p of authProfiles) {
      const a = auth.find(x => x.id === p.id);
      console.log(
        `  id=${p.id} email=${a?.email ?? '?'}\n` +
        `     full_name="${p.full_name ?? ''}" is_approved=${p.is_approved} approved_at=${p.approved_at ?? 'NULL'} approved_by=${p.approved_by ?? 'NULL'}\n` +
        `     role=${roleLabel(p.system_role_id)} employee_id=${p.employee_id ?? 'NULL'} two_factor_enabled=${p.two_factor_enabled} created_at=${p.created_at}`,
      );
    }
  } else {
    console.log('  Пропущено — auth-строк не найдено.');
  }

  section('3. user_profiles по ФИО (orphan-профили без app_auth.users / рассинхрон id)');
  const nameWhere = profileNamePatterns
    .map((_, i) => `up.full_name ILIKE $${i + 1}`)
    .join(' OR ');
  const orphans = (await client.query(
    `SELECT up.id, up.full_name, up.is_approved, up.approved_at, up.approved_by,
            up.system_role_id, up.employee_id, up.created_at,
            au.id AS auth_id, au.email AS auth_email
       FROM user_profiles up
       LEFT JOIN app_auth.users au ON au.id = up.id
      WHERE ${nameWhere}
      ORDER BY up.created_at`,
    profileNamePatterns,
  )).rows;
  if (orphans.length === 0) {
    console.log('  По ФИО профили не найдены.');
  } else {
    for (const p of orphans) {
      const flag = p.auth_id ? '' : '  <<< ORPHAN: профиль БЕЗ app_auth.users (вход по нему невозможен)';
      console.log(
        `  profile_id=${p.id} full_name="${p.full_name ?? ''}" is_approved=${p.is_approved} approved_at=${p.approved_at ?? 'NULL'}\n` +
        `     role=${roleLabel(p.system_role_id)} employee_id=${p.employee_id ?? 'NULL'} auth_id=${p.auth_id ?? 'NULL'} auth_email=${p.auth_email ?? 'NULL'} created_at=${p.created_at}${flag}`,
      );
    }
  }

  section('4. audit_logs (USER_APPROVED / USER_REJECTED / USER_DELETED)');
  const ids = [...new Set([...authIds, ...authProfiles.map(p => p.id), ...orphans.map(p => p.id)])];
  if (ids.length === 0) {
    console.log('  Пропущено — id-кандидатов нет.');
  } else {
    const audit = (await client.query(
      `SELECT id, user_id, action, entity_type, entity_id, details, created_at
         FROM audit_logs
        WHERE action IN ('USER_APPROVED','USER_REJECTED','USER_DELETED')
          AND entity_id::text = ANY($1::text[])
        ORDER BY created_at DESC`,
      [ids],
    )).rows;
    if (audit.length === 0) {
      console.log('  Записей об одобрении/отклонении/удалении НЕТ (одобрение, вероятно, не выполнялось).');
    } else {
      for (const a of audit) {
        console.log(`  ${a.created_at} action=${a.action} entity_id=${a.entity_id} by user_id=${a.user_id ?? 'NULL'} details=${JSON.stringify(a.details)}`);
      }
    }
  }

  section('Итог');
  const lp = authProfiles[0];
  if (!lp) {
    console.log('Login-профиль не найден → проблема на уровне регистрации/auth (секции 1-2).');
  } else if (lp.is_approved) {
    console.log('Login-профиль is_approved=TRUE → код корректен. Причина: протухший JWT/кэш — пользователю выйти и зайти заново.');
  } else {
    console.log('Login-профиль is_approved=FALSE → см. секцию 4 (одобряли ли) и секцию 3 (одобрили ли ДРУГУЮ/orphan-строку).');
  }
}

const client = new Client({
  connectionString: connStr,
  ssl: { ca, rejectUnauthorized: true },
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
});
try {
  await client.connect();
  const rep = await client.query('SELECT pg_is_in_recovery() AS r');
  console.log(`connected (${rep.rows[0].r ? 'replica' : 'PRIMARY'})`);
  await runDiagnostics(client);
  await client.end();
  console.log('\nГотово (изменения в БД не вносились).');
  process.exit(0);
} catch (err) {
  console.error(`Ошибка диагностики: ${err?.message ?? err}`);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
}
