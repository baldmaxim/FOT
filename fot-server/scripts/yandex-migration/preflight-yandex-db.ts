// preflight-yandex-db.ts
//
// Финальная проверка готовности target Yandex Managed PG к запуску
// fot-server в проде. Запускается ПОСЛЕ всех 9 шагов ран-бука
// (05_public_data.md): pre-data → data → post-data → fix-sequences →
// verify-public → validate-auth-fk → подтверждение бакета YOS.
//
// Скрипт ТОЛЬКО ЧИТАЕТ, никаких DDL/DML. Безопасно повторно прогонять,
// можно подключать в CI как pre-deploy gate.
//
// Output:
//   .migration/yandex_preflight_report.json  — полный машиночитаемый
//   .migration/yandex_preflight_report.md    — человекочитаемый
//
// Exit codes:
//   0 — все critical проверки passed
//   1 — есть хоть один critical fail (см. отчёт)
//   2 — ENV / коннект / нештатное падение

import fs from 'node:fs';
import path from 'node:path';
import { Client, type ClientConfig } from 'pg';

const REPORT_DIR = '.migration';
const REPORT_JSON = path.join(REPORT_DIR, 'yandex_preflight_report.json');
const REPORT_MD = path.join(REPORT_DIR, 'yandex_preflight_report.md');

const REQUIRED_SCHEMAS = ['public', 'app_auth'] as const;

const REQUIRED_TABLES: ReadonlyArray<{ schema: string; table: string }> = [
  { schema: 'app_auth', table: 'users' },
  { schema: 'public', table: 'user_profiles' },
  { schema: 'public', table: 'employees' },
  { schema: 'public', table: 'employee_direct_reports' },
  { schema: 'public', table: 'user_company_access' },
  { schema: 'public', table: 'skud_events' },
  { schema: 'public', table: 'skud_event_failures' },
  { schema: 'public', table: 'skud_daily_summary' },
  { schema: 'public', table: 'sigur_runtime_state' },
  { schema: 'public', table: 'data_api_keys' },
  { schema: 'public', table: 'data_api_key_tables' },
  { schema: 'public', table: 'documents' },
  { schema: 'public', table: 'document_links' },
];

// 11 backend-called runtime функций + 1 DB-internal helper dependency = 12.
const REQUIRED_FUNCTIONS = [
  'batch_recalculate_skud_daily_summary',
  'bulk_update_employee_ids',
  'find_skud_duplicate_ids',
  'find_direct_conversation',
  'replace_role_access_profile',
  'data_api_list_public_schema',
  'get_descendant_department_ids',
  'try_acquire_sigur_runtime_lease',
  'heartbeat_sigur_runtime_lease',
  'merge_sigur_runtime_state',
  'release_sigur_runtime_lease',
  // Helper: DB-internal зависимость batch_recalculate_skud_daily_summary,
  // backend'ом напрямую не вызывается, но без неё батч упадёт при
  // первом же вызове.
  'recalculate_skud_daily_summary',
] as const;

// Дополнительный контекст для проверки — какие функции являются helper'ами
// (а не called-from-backend). Используется только для пометки в детали
// результата.
const FUNCTION_NOTES: Readonly<Record<string, string>> = {
  recalculate_skud_daily_summary:
    'helper — DB-internal dependency of batch_recalculate_skud_daily_summary (backend не вызывает напрямую)',
};

const REQUIRED_EXTENSIONS = ['btree_gist', 'pg_trgm', 'pgcrypto'] as const;

const SUPABASE_ROLES = ['anon', 'authenticated', 'service_role'] as const;

// FK, которые должны существовать в target после
// validate-auth-fk.ts (главный, kind=primary) и
// 089_yandex_auth_user_fks.sql + validate-auth-fks.ts (secondary).
//
// Имена FK берутся из validate-auth-fk.ts (FK_NAME) и
// validate-auth-fks.ts (SECONDARY_FKS). Если в target имя расходится
// с expectedName — фиксируем фактическое в детали проверки.
interface IExpectedAppAuthFk {
  expectedName: string;
  table: string;          // public.<table>
  column: string;
  kind: 'primary' | 'secondary';
}

const EXPECTED_APP_AUTH_FKS: ReadonlyArray<IExpectedAppAuthFk> = [
  { expectedName: 'user_profiles_id_fkey_app_auth',     table: 'user_profiles',        column: 'id',          kind: 'primary' },
  { expectedName: 'user_profiles_approved_by_fkey',     table: 'user_profiles',        column: 'approved_by', kind: 'secondary' },
  { expectedName: 'audit_logs_user_id_fkey',            table: 'audit_logs',           column: 'user_id',     kind: 'secondary' },
  { expectedName: 'employee_assignments_created_by_fkey', table: 'employee_assignments', column: 'created_by',  kind: 'secondary' },
  { expectedName: 'fk_push_subscriptions_user',         table: 'push_subscriptions',   column: 'user_id',     kind: 'secondary' },
  { expectedName: 'tender_salary_history_created_by_fkey', table: 'salary_history',     column: 'created_by',  kind: 'secondary' },
];

const RUNTIME_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ENCRYPTION_KEY',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'SIGUR_RUNTIME_ALLOWED_HOSTS',
] as const;

// ─── Типы ────────────────────────────────────────────────────────────────

interface IArgs {
  help: boolean;
}

type CheckStatus = 'ok' | 'warn' | 'fail';

interface ICheckResult {
  category: string;
  name: string;
  status: CheckStatus;
  critical: boolean;
  detail?: string;
  sample?: unknown;
}

const HELP = `preflight-yandex-db — финальная read-only проверка target Yandex Managed PG

Usage:
  npm run migrate:yandex:preflight -- [--help]

ENV:
  TARGET_DATABASE_URL   postgres://...  (required) — Yandex Managed PG
  TARGET_SSL            true|false (default: true)
  TARGET_SSL_CA_PATH    /path/to/ca.pem (optional, обычно нужен для YC)

Проверяет 10 групп:
  1.  version_info          — SELECT version(), current_database, current_user
  2.  schemas               — public, app_auth существуют
  3.  tables                — 13 ключевых таблиц существуют
  4.  functions             — 12 функций (11 runtime + 1 helper dependency) существуют
  5.  extensions            — btree_gist / pg_trgm / pgcrypto или gen_random_uuid()
  6.  incompat              — FK на auth.users / storage.objects, FORCE RLS,
                              Supabase-роли (anon/authenticated/service_role)
  7.  auth                  — orphans user_profiles, формат password_hash,
                              дубликаты lower(email), наличие approved admin
  8.  data                  — sequences aligned, key_hash формат SHA-256,
                              shape partitioned/plain/missing для skud_events
                              (critical) и skud_event_failures (warning при
                              plain — production-parity, см.
                              07_skud_event_failures_partitioning.md)
  9.  app_auth_foreign_keys — все 6 FK на app_auth.users существуют, ссылаются
                              на app_auth.users (а не на auth.users) и
                              convalidated=true. Должна проходить ПОСЛЕ
                              validate-auth-fk (главный FK user_profiles_id)
                              и validate-auth-fks (5 secondary FK через 089).
                              FK на отсутствующую таблицу → warn-skip; FK
                              отсутствует, или ссылается не туда, или
                              convalidated=false → critical fail.
  10. env_reminders         — список env vars, которые ОБЯЗАТЕЛЬНО задать в
                              fot-server/.env перед запуском (info-only)

Output:
  .migration/yandex_preflight_report.{json,md} — полный отчёт
  Console — короткое summary

Exit codes:
  0 — все critical OK
  1 — ≥1 critical fail
  2 — ENV / коннект / нештатная ошибка
`;

function parseArgs(argv: readonly string[]): IArgs {
  const out: IArgs = { help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Неизвестный аргумент: ${a}. См. --help.`);
  }
  return out;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function buildSsl(): ClientConfig['ssl'] {
  if (!envFlag('TARGET_SSL', true)) return false;
  const caPath = process.env.TARGET_SSL_CA_PATH;
  if (caPath) {
    const resolved = path.resolve(caPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`TARGET_SSL_CA_PATH указан, но файл не найден: ${resolved}`);
    }
    return { rejectUnauthorized: true, ca: fs.readFileSync(resolved, 'utf8') };
  }
  return { rejectUnauthorized: true };
}

const ok = (category: string, name: string, detail?: string, sample?: unknown): ICheckResult => ({
  category, name, status: 'ok', critical: true, detail, sample,
});
const warn = (category: string, name: string, detail: string, sample?: unknown): ICheckResult => ({
  category, name, status: 'warn', critical: false, detail, sample,
});
const fail = (category: string, name: string, detail: string, sample?: unknown): ICheckResult => ({
  category, name, status: 'fail', critical: true, detail, sample,
});
const info = (category: string, name: string, detail?: string, sample?: unknown): ICheckResult => ({
  category, name, status: 'ok', critical: false, detail, sample,
});

// ─── Проверки ────────────────────────────────────────────────────────────

async function checkVersionInfo(client: Client): Promise<ICheckResult[]> {
  const r = await client.query<{ v: string; db: string; usr: string }>(
    'SELECT version() AS v, current_database() AS db, current_user AS usr;',
  );
  const row = r.rows[0];
  return [
    info('version_info', 'version', undefined, row?.v),
    info('version_info', 'current_database', undefined, row?.db),
    info('version_info', 'current_user', undefined, row?.usr),
  ];
}

async function checkSchemas(client: Client): Promise<ICheckResult[]> {
  const r = await client.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name = ANY($1::text[]);`,
    [REQUIRED_SCHEMAS as unknown as string[]],
  );
  const present = new Set(r.rows.map(x => x.schema_name));
  const out: ICheckResult[] = [];
  for (const s of REQUIRED_SCHEMAS) {
    if (present.has(s)) out.push(ok('schemas', s));
    else out.push(fail('schemas', s, 'schema отсутствует'));
  }
  return out;
}

async function checkTables(client: Client): Promise<ICheckResult[]> {
  const pairs = REQUIRED_TABLES.map(t => `${t.schema}.${t.table}`);
  const r = await client.query<{ key: string }>(
    `SELECT table_schema || '.' || table_name AS key
       FROM information_schema.tables
       WHERE table_schema || '.' || table_name = ANY($1::text[])
         AND table_type = 'BASE TABLE';`,
    [pairs],
  );
  const present = new Set(r.rows.map(x => x.key));
  return REQUIRED_TABLES.map(t => {
    const key = `${t.schema}.${t.table}`;
    return present.has(key) ? ok('tables', key) : fail('tables', key, 'таблица отсутствует');
  });
}

async function checkFunctions(client: Client): Promise<ICheckResult[]> {
  const r = await client.query<{ proname: string; prosecdef: boolean; has_search_path: boolean }>(
    `SELECT p.proname,
            p.prosecdef,
            EXISTS (
              SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
               WHERE cfg ILIKE 'search_path=%'
            ) AS has_search_path
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY($1::text[]);`,
    [REQUIRED_FUNCTIONS as unknown as string[]],
  );
  const found = new Map(r.rows.map(x => [x.proname, x]));
  const out: ICheckResult[] = [];
  for (const fn of REQUIRED_FUNCTIONS) {
    const note = FUNCTION_NOTES[fn] ? ` [${FUNCTION_NOTES[fn]}]` : '';
    const row = found.get(fn);
    if (!row) {
      out.push(fail('functions', fn, `функция отсутствует в public${note}`));
      continue;
    }
    if (row.prosecdef && !row.has_search_path) {
      out.push(fail('functions', fn, `SECURITY DEFINER без SET search_path${note}`));
      continue;
    }
    const sdLabel = row.prosecdef ? 'SECURITY DEFINER + search_path' : 'SECURITY INVOKER';
    out.push(ok('functions', fn, `${sdLabel}${note}`));
  }
  return out;
}

async function checkExtensions(client: Client): Promise<ICheckResult[]> {
  const r = await client.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[]);`,
    [REQUIRED_EXTENSIONS as unknown as string[]],
  );
  const present = new Set(r.rows.map(x => x.extname));
  const out: ICheckResult[] = [];
  for (const ext of REQUIRED_EXTENSIONS) {
    if (present.has(ext)) {
      out.push(ok('extensions', ext));
    } else if (ext === 'pgcrypto') {
      // Если расширение не установлено, проверим хотя бы доступность
      // gen_random_uuid() (он есть в PG ≥13 без pgcrypto).
      const fnCheck = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'gen_random_uuid'
              AND n.nspname IN ('public', 'pg_catalog')
         ) AS exists;`,
      );
      if (fnCheck.rows[0]?.exists) {
        out.push(warn('extensions', ext, 'pgcrypto не установлен, но gen_random_uuid() доступен из pg_catalog (PG ≥13)'));
      } else {
        out.push(fail('extensions', ext, 'pgcrypto не установлен и gen_random_uuid() недоступен'));
      }
    } else {
      out.push(fail('extensions', ext, 'расширение не установлено'));
    }
  }
  return out;
}

async function checkIncompat(client: Client): Promise<ICheckResult[]> {
  const out: ICheckResult[] = [];

  // 1. FK на auth.users / storage.objects (любая таблица public)
  const fk = await client.query<{
    conname: string; from_table: string; to_schema: string; to_table: string;
  }>(
    `SELECT c.conname,
            ns.nspname || '.' || t.relname AS from_table,
            fns.nspname AS to_schema,
            ft.relname AS to_table
       FROM pg_constraint c
       JOIN pg_class t   ON t.oid  = c.conrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
       JOIN pg_class ft  ON ft.oid = c.confrelid
       JOIN pg_namespace fns ON fns.oid = ft.relnamespace
      WHERE c.contype = 'f'
        AND ((fns.nspname = 'auth' AND ft.relname = 'users')
          OR (fns.nspname = 'storage' AND ft.relname = 'objects'));`,
  );
  if (fk.rows.length === 0) {
    out.push(ok('incompat', 'no_fk_to_supabase_only', 'нет FK на auth.users / storage.objects'));
  } else {
    out.push(fail(
      'incompat',
      'no_fk_to_supabase_only',
      `${fk.rows.length} FK ссылаются на Supabase-схемы — должны быть либо удалены, либо переадресованы на app_auth.users`,
      fk.rows.slice(0, 10),
    ));
  }

  // 2. FORCE RLS на application tables (public)
  const forceRls = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relrowsecurity = true
        AND c.relforcerowsecurity = true;`,
  );
  if (forceRls.rows.length === 0) {
    out.push(ok('incompat', 'no_force_rls', 'нет FORCE RLS на public.*'));
  } else {
    out.push(fail(
      'incompat',
      'no_force_rls',
      `${forceRls.rows.length} таблиц с FORCE RLS — на Yandex без ролей anon/authenticated это блокирует runtime`,
      forceRls.rows.map(r => r.relname).slice(0, 20),
    ));
  }

  // 3. Существуют ли роли anon/authenticated/service_role
  const sbRoles = await client.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]);`,
    [SUPABASE_ROLES as unknown as string[]],
  );
  if (sbRoles.rows.length === 0) {
    out.push(ok('incompat', 'no_supabase_roles', 'роли anon/authenticated/service_role отсутствуют'));
  } else {
    out.push(fail(
      'incompat',
      'no_supabase_roles',
      `найдены Supabase-роли: ${sbRoles.rows.map(r => r.rolname).join(', ')} — это либо лишний накат, либо непочищенный dump`,
      sbRoles.rows.map(r => r.rolname),
    ));
  }
  return out;
}

async function checkAuth(client: Client): Promise<ICheckResult[]> {
  const out: ICheckResult[] = [];

  // 1. Orphans user_profiles без app_auth.users
  const orphans = await client.query<{ c: string }>(
    `SELECT count(*)::text AS c
       FROM public.user_profiles up
      WHERE NOT EXISTS (SELECT 1 FROM app_auth.users a WHERE a.id = up.id);`,
  );
  const orphanCount = Number.parseInt(orphans.rows[0]?.c ?? '0', 10);
  if (orphanCount === 0) {
    out.push(ok('auth', 'orphan_user_profiles', '0 user_profiles без app_auth.users'));
  } else {
    out.push(fail('auth', 'orphan_user_profiles', `${orphanCount} user_profiles без app_auth.users — повторите backfill`));
  }

  // 2. Все password_hash имеют bcrypt-prefix $2[aby]$
  const badHash = await client.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM app_auth.users WHERE password_hash !~ '^\\$2[aby]\\$';`,
  );
  const badHashCount = Number.parseInt(badHash.rows[0]?.c ?? '0', 10);
  if (badHashCount === 0) {
    out.push(ok('auth', 'password_hash_format', 'все password_hash имеют $2[aby]$-prefix'));
  } else {
    out.push(fail('auth', 'password_hash_format', `${badHashCount} users с неподдерживаемым форматом hash`));
  }

  // 3. Дубликаты lower(email)
  const dups = await client.query<{ email: string; c: string }>(
    `SELECT lower(email) AS email, count(*)::text AS c
       FROM app_auth.users GROUP BY 1 HAVING count(*) > 1 LIMIT 10;`,
  );
  if (dups.rows.length === 0) {
    out.push(ok('auth', 'no_duplicate_emails', 'дубликаты lower(email) не найдены'));
  } else {
    out.push(fail(
      'auth', 'no_duplicate_emails',
      `найдено ${dups.rows.length} дубликатов lower(email) (показаны первые 10)`,
      dups.rows,
    ));
  }

  // 4. Approved admin exists
  const admin = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.user_profiles up
         JOIN public.system_roles sr ON sr.id = up.system_role_id
        WHERE up.is_approved = true AND sr.is_admin = true
     ) AS exists;`,
  );
  if (admin.rows[0]?.exists) {
    out.push(ok('auth', 'approved_admin_exists', 'есть хотя бы один подтверждённый is_admin=true'));
  } else {
    out.push(fail(
      'auth', 'approved_admin_exists',
      'ни одного approved пользователя с is_admin=true — после деплоя некому будет управлять системой',
    ));
  }

  return out;
}

async function checkData(client: Client): Promise<ICheckResult[]> {
  const out: ICheckResult[] = [];

  // 1. Sequences aligned: для каждой sequence, привязанной к колонке через
  // pg_depend, MAX(col) ≤ last_value текущей sequence (next будет > MAX).
  const seqMisaligned = await client.query<{
    seq: string; tbl: string; col: string; max_val: string | null; last_val: string;
  }>(
    `WITH seqs AS (
       SELECT c_s.oid AS seq_oid,
              ns_s.nspname || '.' || c_s.relname AS seq,
              ns_t.nspname || '.' || c_t.relname AS tbl,
              a.attname AS col
         FROM pg_class c_s
         JOIN pg_namespace ns_s ON ns_s.oid = c_s.relnamespace
         JOIN pg_depend d ON d.objid = c_s.oid AND d.deptype = 'a'
         JOIN pg_class c_t ON c_t.oid = d.refobjid
         JOIN pg_namespace ns_t ON ns_t.oid = c_t.relnamespace
         JOIN pg_attribute a ON a.attrelid = c_t.oid AND a.attnum = d.refobjsubid
        WHERE c_s.relkind = 'S'
          AND ns_s.nspname = 'public'
          AND ns_t.nspname = 'public'
     )
     SELECT seq, tbl, col, NULL::text AS max_val, NULL::text AS last_val
       FROM seqs LIMIT 0;`,
  );
  // Двухэтапная стратегия: получили список seq+table+col, теперь для
  // каждой делаем отдельный SELECT — иначе требовалась бы dynamic SQL,
  // а pg-driver не умеет EXECUTE FORMAT прямо.
  const seqList = await client.query<{ seq: string; tbl: string; col: string }>(
    `SELECT
        ns_s.nspname || '.' || c_s.relname AS seq,
        ns_t.nspname || '.' || c_t.relname AS tbl,
        a.attname AS col
       FROM pg_class c_s
       JOIN pg_namespace ns_s ON ns_s.oid = c_s.relnamespace
       JOIN pg_depend d ON d.objid = c_s.oid AND d.deptype = 'a'
       JOIN pg_class c_t ON c_t.oid = d.refobjid
       JOIN pg_namespace ns_t ON ns_t.oid = c_t.relnamespace
       JOIN pg_attribute a ON a.attrelid = c_t.oid AND a.attnum = d.refobjsubid
      WHERE c_s.relkind = 'S' AND ns_s.nspname = 'public' AND ns_t.nspname = 'public';`,
  );

  const misaligned: Array<{ seq: string; tbl: string; col: string; max_val: string; last_val: string }> = [];
  for (const row of seqList.rows) {
    // Both `seq` and `tbl.col` are validated via pg_class (no SQL injection — they're real identifiers from catalog).
    const safe = (s: string): string => s.replace(/"/g, '""');
    const seqLastValQ = `SELECT last_value::text FROM ${row.seq.split('.').map(p => `"${safe(p)}"`).join('.')};`;
    const maxQ = `SELECT COALESCE(MAX("${safe(row.col)}")::text, '') AS m FROM ${row.tbl.split('.').map(p => `"${safe(p)}"`).join('.')};`;
    try {
      const seqR = await client.query<{ last_value: string }>(seqLastValQ);
      const maxR = await client.query<{ m: string }>(maxQ);
      const maxV = maxR.rows[0]?.m ?? '';
      const lastV = seqR.rows[0]?.last_value ?? '0';
      if (maxV !== '' && BigInt(maxV) > BigInt(lastV)) {
        misaligned.push({ seq: row.seq, tbl: row.tbl, col: row.col, max_val: maxV, last_val: lastV });
      }
    } catch {
      // на nonexistent sequence/column просто пропускаем — отдельный seqList уже отфильтровал
    }
  }
  if (misaligned.length === 0) {
    out.push(ok('data', 'sequences_aligned', `${seqList.rows.length} sequences проверены, все ≥ MAX(col)`));
  } else {
    out.push(fail(
      'data', 'sequences_aligned',
      `${misaligned.length} sequences отстают от MAX(col) — следующий INSERT упадёт. Запустите fix-sequences`,
      misaligned.slice(0, 10),
    ));
  }

  // 2. data_api_keys.key_hash формат: ровно 64 hex-символа (SHA-256 в hex)
  const keysExists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'data_api_keys'
     ) AS exists;`,
  );
  if (keysExists.rows[0]?.exists) {
    const badKey = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM public.data_api_keys
        WHERE key_hash IS NULL OR length(key_hash) <> 64 OR key_hash !~ '^[a-f0-9]+$';`,
    );
    const badKeyCount = Number.parseInt(badKey.rows[0]?.c ?? '0', 10);
    if (badKeyCount === 0) {
      out.push(ok('data', 'data_api_key_hash_format', 'все key_hash — 64 hex (SHA-256)'));
    } else {
      out.push(fail(
        'data', 'data_api_key_hash_format',
        `${badKeyCount} строк в data_api_keys с key_hash не в формате SHA-256 hex (64 символа)`,
      ));
    }
  } else {
    out.push(fail('data', 'data_api_key_hash_format', 'таблица data_api_keys отсутствует'));
  }

  // 3. Партиционирование skud_events / skud_event_failures.
  //
  // Production source-side диагностика (см. STAGING_REHEARSAL_REPORT.md
  // Finding 1) показала, что skud_event_failures в боевом Supabase —
  // **обычная таблица** (relkind='r'), несмотря на 085. На time-of-cutover
  // мы сохраняем production-parity: plain shape не блокирует.
  //
  // Politik:
  //   skud_events:
  //     - missing → critical fail
  //     - plain table → critical fail (теряем партиционирование, поломка
  //       масштабирования)
  //     - partitioned + 0 partitions → critical fail (attach сломался)
  //     - partitioned + ≥1 partition → ok
  //   skud_event_failures:
  //     - missing → critical fail
  //     - plain table → **warning** (production-parity; рекомендация —
  //       отдельная post-cutover миграция, см. 07_skud_event_failures_partitioning.md)
  //     - partitioned + 0 partitions → critical fail
  //     - partitioned + ≥1 partition → ok
  const shapes = await client.query<{ relname: string; relkind: string; child_count: number }>(
    `SELECT p.relname,
            p.relkind::text,
            COALESCE((SELECT count(*)::int FROM pg_inherits WHERE inhparent = p.oid), 0) AS child_count
       FROM pg_class p
       JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'public'
        AND p.relname = ANY($1::text[])
        AND p.relkind IN ('r','p');`,
    [['skud_events', 'skud_event_failures']],
  );
  const shapeMap = new Map(shapes.rows.map(r => [r.relname, r]));

  // skud_events
  {
    const row = shapeMap.get('skud_events');
    const sample = {
      shape: row ? (row.relkind === 'p' ? 'partitioned' : 'plain') : 'missing',
      partition_count: row?.child_count ?? 0,
    };
    if (!row) {
      out.push(fail('data', 'partitions_public_skud_events',
        'public.skud_events отсутствует', sample));
    } else if (row.relkind === 'r') {
      out.push(fail('data', 'partitions_public_skud_events',
        'public.skud_events — обычная таблица, ожидается partitioned (миграция 085 + 034)',
        sample));
    } else if (row.child_count === 0) {
      out.push(fail('data', 'partitions_public_skud_events',
        'public.skud_events — partitioned, но ни одной партиции не attached',
        sample));
    } else {
      out.push({
        ...ok('data', 'partitions_public_skud_events',
          `${row.child_count} партиций attached`),
        sample,
      });
    }
  }

  // skud_event_failures — production-parity allowance
  {
    const row = shapeMap.get('skud_event_failures');
    const shape = row ? (row.relkind === 'p' ? 'partitioned' : 'plain') : 'missing';
    const sample = {
      skud_event_failures_shape: shape,
      skud_event_failures_partition_count: row?.child_count ?? 0,
    };
    if (!row) {
      out.push(fail('data', 'partitions_public_skud_event_failures',
        'public.skud_event_failures отсутствует', sample));
    } else if (row.relkind === 'r') {
      out.push(warn('data', 'partitions_public_skud_event_failures',
        'production source currently has plain skud_event_failures; repartition should be a separate post-cutover migration (см. 07_skud_event_failures_partitioning.md)',
        sample));
    } else if (row.child_count === 0) {
      out.push(fail('data', 'partitions_public_skud_event_failures',
        'public.skud_event_failures — partitioned, но 0 партиций attached',
        sample));
    } else {
      out.push({
        ...ok('data', 'partitions_public_skud_event_failures',
          `${row.child_count} партиций attached`),
        sample,
      });
    }
  }

  return out;
}

async function checkAppAuthForeignKeys(client: Client): Promise<ICheckResult[]> {
  const out: ICheckResult[] = [];
  const requiredTableKeys = new Set(
    REQUIRED_TABLES.map(t => `${t.schema}.${t.table}`),
  );

  for (const fk of EXPECTED_APP_AUTH_FKS) {
    const checkName = `${fk.kind}:${fk.expectedName}`;
    const qualified = `public.${fk.table}`;

    // 1. Проверяем, что source-таблица существует. Если её нет —
    // дублировать шум с группой `tables` не нужно: warn-skip.
    const tblExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = $1
            AND table_type = 'BASE TABLE'
       ) AS exists;`,
      [fk.table],
    );
    if (!tblExists.rows[0]?.exists) {
      const alreadyRequired = requiredTableKeys.has(qualified);
      const note = alreadyRequired
        ? `${qualified} отсутствует — уже отмечено в группе tables, проверка FK пропущена`
        : `${qualified} отсутствует — FK не может существовать; не входит в required public tables`;
      out.push(warn('app_auth_foreign_keys', checkName, note, {
        constraint_name: fk.expectedName,
        source_table: qualified,
        source_column: fk.column,
        referenced_schema: null,
        referenced_table: null,
        convalidated: null,
        status: 'skipped_table_missing',
      }));
      continue;
    }

    // 2. Ищем FK на (table, column). Если несколько — берём тот,
    // что ссылается на app_auth.users (актуальный). Single-column.
    const fkRows = await client.query<{
      conname: string;
      convalidated: boolean;
      ref_schema: string | null;
      ref_table: string | null;
    }>(
      `SELECT c.conname,
              c.convalidated,
              fns.nspname AS ref_schema,
              ft.relname  AS ref_table
         FROM pg_constraint c
         JOIN pg_class t      ON t.oid = c.conrelid
         JOIN pg_namespace ns ON ns.oid = t.relnamespace
         JOIN pg_attribute a  ON a.attrelid = t.oid
                              AND a.attname = $2
                              AND a.attnum  = ANY(c.conkey)
         LEFT JOIN pg_class ft     ON ft.oid  = c.confrelid
         LEFT JOIN pg_namespace fns ON fns.oid = ft.relnamespace
        WHERE c.contype = 'f'
          AND ns.nspname = 'public'
          AND t.relname  = $1
          AND array_length(c.conkey, 1) = 1;`,
      [fk.table, fk.column],
    );

    if (fkRows.rows.length === 0) {
      const hint = fk.kind === 'primary'
        ? 'запустите validate-auth-fk.ts'
        : 'запустите 089_yandex_auth_user_fks.sql + validate-auth-fks.ts';
      out.push(fail(
        'app_auth_foreign_keys', checkName,
        `FK на ${qualified}(${fk.column}) → app_auth.users(id) отсутствует — ${hint}`,
        {
          constraint_name: fk.expectedName,
          source_table: qualified,
          source_column: fk.column,
          referenced_schema: null,
          referenced_table: null,
          convalidated: null,
          status: 'missing',
        },
      ));
      continue;
    }

    const appAuthMatch = fkRows.rows.find(
      r => r.ref_schema === 'app_auth' && r.ref_table === 'users',
    );

    if (!appAuthMatch) {
      const first = fkRows.rows[0]!;
      const refLabel = `${first.ref_schema ?? '?'}.${first.ref_table ?? '?'}`;
      out.push(fail(
        'app_auth_foreign_keys', checkName,
        `FK ${first.conname} на ${qualified}(${fk.column}) ссылается на ${refLabel}, а не на app_auth.users — повторите ${fk.kind === 'primary' ? 'validate-auth-fk.ts' : '089 + validate-auth-fks.ts'}`,
        {
          constraint_name: first.conname,
          source_table: qualified,
          source_column: fk.column,
          referenced_schema: first.ref_schema,
          referenced_table: first.ref_table,
          convalidated: first.convalidated,
          status: 'wrong_target',
        },
      ));
      continue;
    }

    if (!appAuthMatch.convalidated) {
      out.push(fail(
        'app_auth_foreign_keys', checkName,
        `FK ${appAuthMatch.conname} → app_auth.users существует, но convalidated=false — VALIDATE CONSTRAINT не вызывался или провалился`,
        {
          constraint_name: appAuthMatch.conname,
          source_table: qualified,
          source_column: fk.column,
          referenced_schema: 'app_auth',
          referenced_table: 'users',
          convalidated: false,
          status: 'not_validated',
        },
      ));
      continue;
    }

    const nameLabel = appAuthMatch.conname === fk.expectedName
      ? `${appAuthMatch.conname} (validated)`
      : `${appAuthMatch.conname} (validated; ожидалось имя ${fk.expectedName} — не блокирует, но проверьте)`;
    out.push({
      ...ok('app_auth_foreign_keys', checkName, `${fk.kind}: ${nameLabel}`),
      sample: {
        constraint_name: appAuthMatch.conname,
        source_table: qualified,
        source_column: fk.column,
        referenced_schema: 'app_auth',
        referenced_table: 'users',
        convalidated: true,
        status: 'ok',
      },
    });
  }

  return out;
}

function checkEnvReminders(): ICheckResult[] {
  // Скрипт работает с TARGET_DATABASE_URL — это другая БД, чем у
  // fot-server. Реально провалидировать его .env мы не можем; просто
  // напоминаем оператору, что должно быть выставлено.
  return RUNTIME_ENV_VARS.map(v =>
    info('env_reminders', v, `должна быть выставлена в fot-server/.env перед запуском (этот скрипт значение НЕ проверяет)`),
  );
}

// ─── Output ──────────────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const d = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function renderMarkdown(results: ICheckResult[], summary: { total: number; ok: number; warn: number; fail: number; critical_fail: number }): string {
  const L: string[] = [];
  L.push('# Yandex Managed PG — preflight report');
  L.push('');
  L.push(`- Generated: ${new Date().toISOString()}`);
  L.push(`- Total checks: ${summary.total}`);
  L.push(`- OK: ${summary.ok}`);
  L.push(`- WARN: ${summary.warn}`);
  L.push(`- FAIL: ${summary.fail} (critical: ${summary.critical_fail})`);
  L.push('');

  const categories = [...new Set(results.map(r => r.category))];
  for (const cat of categories) {
    L.push(`## ${cat}`);
    L.push('');
    L.push('| Check | Status | Critical | Detail |');
    L.push('|---|---|---|---|');
    for (const r of results.filter(x => x.category === cat)) {
      const icon = r.status === 'ok' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
      const crit = r.critical ? 'yes' : 'no';
      const det = (r.detail ?? '').replace(/\|/g, '\\|');
      L.push(`| \`${r.name}\` | ${icon} ${r.status} | ${crit} | ${det} |`);
    }
    L.push('');
    const samples = results.filter(x => x.category === cat && x.sample !== undefined);
    if (samples.length > 0) {
      L.push(`### ${cat}: samples`);
      L.push('');
      for (const s of samples) {
        L.push(`- **${s.name}**:`);
        L.push('  ```json');
        L.push('  ' + JSON.stringify(s.sample, null, 2).split('\n').join('\n  '));
        L.push('  ```');
      }
      L.push('');
    }
  }
  return L.join('\n') + '\n';
}

// ─── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: IArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error('\n' + HELP);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const url = process.env.TARGET_DATABASE_URL;
  if (!url) {
    console.error('ERROR: TARGET_DATABASE_URL не задан');
    process.exit(2);
  }

  let ssl: ClientConfig['ssl'];
  try {
    ssl = buildSsl();
  } catch (err) {
    console.error('ERROR:', (err as Error).message);
    process.exit(2);
  }

  const client = new Client({ connectionString: url, ssl });
  try {
    await client.connect();
  } catch (err) {
    console.error('ERROR: не удалось подключиться к TARGET:', (err as Error).message);
    process.exit(2);
  }

  const results: ICheckResult[] = [];

  try {
    results.push(...await checkVersionInfo(client));
    results.push(...await checkSchemas(client));
    results.push(...await checkTables(client));
    results.push(...await checkFunctions(client));
    results.push(...await checkExtensions(client));
    results.push(...await checkIncompat(client));

    // auth/data зависят от наличия таблиц — пропускаем, если базовые
    // tables-checks провалились.
    const tablesMissing = results.some(
      r => r.category === 'tables' && r.status === 'fail',
    );
    if (tablesMissing) {
      results.push(warn(
        'auth', 'skipped',
        'auth-проверки пропущены: некоторые таблицы из обязательного списка отсутствуют',
      ));
      results.push(warn(
        'data', 'skipped',
        'data-проверки пропущены: некоторые таблицы из обязательного списка отсутствуют',
      ));
      results.push(warn(
        'app_auth_foreign_keys', 'skipped',
        'FK-проверки на app_auth.users пропущены: базовые таблицы (app_auth.users/public.user_profiles) отсутствуют',
      ));
    } else {
      try {
        results.push(...await checkAuth(client));
      } catch (err) {
        results.push(fail('auth', 'error', (err as Error).message));
      }
      try {
        results.push(...await checkData(client));
      } catch (err) {
        results.push(fail('data', 'error', (err as Error).message));
      }
      try {
        results.push(...await checkAppAuthForeignKeys(client));
      } catch (err) {
        results.push(fail('app_auth_foreign_keys', 'error', (err as Error).message));
      }
    }

    results.push(...checkEnvReminders());
  } finally {
    await client.end().catch(() => undefined);
  }

  const summary = {
    total: results.length,
    ok: results.filter(r => r.status === 'ok').length,
    warn: results.filter(r => r.status === 'warn').length,
    fail: results.filter(r => r.status === 'fail').length,
    critical_fail: results.filter(r => r.status === 'fail' && r.critical).length,
  };

  ensureDir(REPORT_JSON);
  fs.writeFileSync(
    REPORT_JSON,
    JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(REPORT_MD, renderMarkdown(results, summary), 'utf8');

  console.log('');
  console.log('─── preflight summary ───');
  console.log(`  ok=${summary.ok}  warn=${summary.warn}  fail=${summary.fail}  (critical_fail=${summary.critical_fail})`);
  console.log(`  report: ${REPORT_JSON}`);
  console.log(`  report: ${REPORT_MD}`);
  if (summary.critical_fail > 0) {
    console.log('');
    console.log('CRITICAL FAILS:');
    for (const r of results.filter(x => x.status === 'fail' && x.critical)) {
      console.log(`  ✗ [${r.category}] ${r.name} — ${r.detail ?? ''}`);
    }
  }

  process.exit(summary.critical_fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
