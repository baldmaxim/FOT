// Превентивный аудит политик ON DELETE у внешних ключей на пользователя
// (public.user_profiles / app_auth.users).
//
// Зачем: FK без явного ON DELETE создаётся с NO ACTION и молча ломает удаление
// учётки (23503 → 500 «Failed to delete user»), а лишний CASCADE наоборот тихо
// уносит деловые строки — заявки, табели, расчётные листки, документы, аудит.
// Миграция 097 правила не закрепила, и каждая новая колонка «кто сделал»
// повторяла проблему. Политику задаёт миграция 284, этот скрипт её стережёт.
//
// Правила (уточнены миграцией 285):
//   own                      — строка принадлежит самой учётке → CASCADE
//   author, колонка NOT NULL — SET DEFAULT на надгробие (имя в UI сохраняется)
//   author, колонка NULL     — SET NULL, DEFAULT отсутствует: с DEFAULT'ом
//                              INSERT без автора писал бы надгробие вместо NULL
//   keep_null                — ссылка не показывается как автор → SET NULL
//   любая колонка вне списков                     → нарушение (нужно решение)
//   NO ACTION / RESTRICT / SET DEFAULT без надгробия / SET NULL на NOT NULL
//                                                 → нарушение
//
// Запуск:
//   npx tsx scripts/audit-user-fk.ts                       (DATABASE_URL из окружения)
//   npx tsx scripts/audit-user-fk.ts --env PATH --ca PATH  (как раннер миграций)
//   FOT_TEST_PG_URL=postgres://... npx tsx scripts/audit-user-fk.ts   (иная БД)
//
// Выход: 0 — политика соблюдена, 1 — есть нарушения.

import fs from 'fs';
import { Client } from 'pg';
import { TOMBSTONE_USER_ID } from '../src/config/system-users.js';

/** Строка принадлежит самой учётке и должна уходить вместе с ней. */
const OWNERSHIP = new Set<string>([
  'public.chat_contact_grants.user_a_id',
  'public.chat_contact_grants.user_b_id',
  'public.chat_contact_requests.requester_id',
  'public.chat_contact_requests.target_user_id',
  'public.chat_participants.user_id',
  'public.contractor_activation_batches.created_by',
  'public.contractor_org_access.user_id',
  'public.employee_hr_drafts.created_by',
  'public.push_subscriptions.user_id',
  'public.timekeeper_folder_access.timekeeper_user_id',
  'public.timekeeper_object_access.timekeeper_user_id',
  'public.timesheet_reminder_log.user_id',
  'public.timesheet_responsibles.user_id',
  'public.user_company_access.user_id',
  'public.user_employee_access.user_id',
  'public.user_profiles.id',
]);

/** Ссылка не отображается как автор — обнуление корректнее надгробия. */
const KEEP_NULL = new Set<string>([
  'public.adaptive_test_sessions.user_id',
  'public.user_profiles.approved_by',
  'public.user_profiles.supervisor_id',
]);

const EXPECTED_DEFAULT = `'${TOMBSTONE_USER_ID}'::uuid`;

interface FkRow {
  schema: string;
  table: string;
  column: string;
  target: string;
  constraint_name: string;
  del: string;
  not_null: boolean;
  column_default: string | null;
}

interface Violation {
  key: string;
  constraintName: string;
  reason: string;
  fix: string;
}

const POLICY_SQL = `
  SELECT n.nspname                                   AS schema,
         t.relname                                   AS table,
         a.attname                                   AS column,
         fn.nspname || '.' || ft.relname             AS target,
         c.conname                                   AS constraint_name,
         c.confdeltype::text                         AS del,
         a.attnotnull                                AS not_null,
         pg_get_expr(d.adbin, d.adrelid)             AS column_default
    FROM pg_constraint c
    JOIN pg_class t        ON t.oid = c.conrelid
    JOIN pg_namespace n    ON n.oid = t.relnamespace
    JOIN pg_class ft       ON ft.oid = c.confrelid
    JOIN pg_namespace fn   ON fn.oid = ft.relnamespace
    JOIN pg_attribute a    ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    LEFT JOIN pg_attrdef d ON d.adrelid = c.conrelid AND d.adnum = a.attnum
   WHERE c.contype = 'f'
     AND c.confrelid IN ('public.user_profiles'::regclass, 'app_auth.users'::regclass)
     AND array_length(c.conkey, 1) = 1
   ORDER BY 1, 2, 3
`;

const DEL_NAMES: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/** --env PATH / --ca PATH — как у scripts/run-migrations.mjs (деплой зовёт так же). */
const parseArgs = (argv: string[]): { env: string | null; ca: string | null } => {
  const opts: { env: string | null; ca: string | null } = { env: null, ca: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env') opts.env = argv[i + 1] ?? null;
    if (argv[i] === '--ca') opts.ca = argv[i + 1] ?? null;
  }
  return opts;
};

/** Значения из .env без раскрытия в лог: наружу отдаём только сам объект. */
const readEnvFile = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const buildSsl = (
  settings: Record<string, string | undefined>,
  caPathOverride: string | null,
): { ca?: string; rejectUnauthorized: boolean } | false => {
  if ((settings.DATABASE_SSL ?? 'true').toLowerCase() === 'false') return false;
  const caPath = caPathOverride || settings.DATABASE_SSL_CA_PATH;
  const rejectUnauthorized = (settings.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false';
  if (caPath && fs.existsSync(caPath)) return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized };
  return { rejectUnauthorized };
};

/** ssl*-параметры в URL указывают на серверные пути — CA подаём отдельно. */
const stripSslParams = (url: string): string => {
  try {
    const parsed = new URL(url);
    for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) parsed.searchParams.delete(p);
    return parsed.toString();
  } catch {
    return url;
  }
};

export function auditRows(rows: FkRow[]): Violation[] {
  const violations: Violation[] = [];

  for (const row of rows) {
    const key = `${row.schema}.${row.table}.${row.column}`;
    const policy = OWNERSHIP.has(key) ? 'own' : KEEP_NULL.has(key) ? 'keep_null' : 'author';
    const del = DEL_NAMES[row.del] ?? row.del;
    const push = (reason: string, fix: string): void => {
      violations.push({ key, constraintName: row.constraint_name, reason, fix });
    };

    // Колонка не объявлена ни владением, ни исключением: по умолчанию считаем
    // её авторской, но требуем явного решения — иначе новая таблица молча
    // получит чужую политику. Политика зависит от nullability (см. 285).
    if (policy === 'author' && row.not_null) {
      if (row.del !== 'd') {
        push(
          `ON DELETE ${del}, для обязательной авторской колонки ожидалось SET DEFAULT (${row.target})`,
          'добавьте колонку в миграцию-политику как author, либо внесите её в OWNERSHIP/KEEP_NULL этого скрипта',
        );
        continue;
      }
      if (row.column_default !== EXPECTED_DEFAULT) {
        push(
          `SET DEFAULT, но DEFAULT = ${row.column_default ?? 'отсутствует'} вместо надгробия`,
          `ALTER TABLE ${row.schema}.${row.table} ALTER COLUMN ${row.column} SET DEFAULT ${EXPECTED_DEFAULT}`,
        );
        continue;
      }
    }

    if (policy === 'author' && !row.not_null) {
      if (row.del !== 'n') {
        push(
          `ON DELETE ${del}, для авторской колонки с NULL ожидалось SET NULL (${row.target})`,
          'добавьте колонку в миграцию-политику как author, либо внесите её в OWNERSHIP/KEEP_NULL этого скрипта',
        );
        continue;
      }
      if (row.column_default === EXPECTED_DEFAULT) {
        push(
          'DEFAULT = надгробие на колонке, допускающей NULL: INSERT без автора запишет «Удалённого пользователя»',
          `ALTER TABLE ${row.schema}.${row.table} ALTER COLUMN ${row.column} DROP DEFAULT`,
        );
        continue;
      }
    }

    if (policy === 'own' && row.del !== 'c') {
      push(`ON DELETE ${del}, для владения ожидался CASCADE`, 'верните CASCADE или перенесите колонку в author');
      continue;
    }

    if (policy === 'keep_null') {
      if (row.del !== 'n') {
        push(`ON DELETE ${del}, для keep_null ожидался SET NULL`, 'верните SET NULL или перенесите колонку в author');
        continue;
      }
      if (row.not_null) {
        push(
          'SET NULL на колонке NOT NULL — удаление упадёт с 23502',
          'снимите NOT NULL либо переведите колонку в author (SET DEFAULT)',
        );
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const fileEnv = opts.env ? readEnvFile(opts.env) : {};
  const testUrl = process.env.FOT_TEST_PG_URL;
  const connectionString = testUrl || fileEnv.DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('✗ Не задан DATABASE_URL (или FOT_TEST_PG_URL, или --env PATH) — аудит не выполнен.');
    process.exit(1);
  }

  const settings = opts.env ? fileEnv : (process.env as Record<string, string | undefined>);
  const client = new Client({
    connectionString: testUrl ? connectionString : stripSslParams(connectionString),
    ssl: testUrl ? false : buildSsl(settings, opts.ca),
    connectionTimeoutMillis: 10000,
  });
  await client.connect();

  let rows: FkRow[];
  try {
    rows = (await client.query<FkRow>(POLICY_SQL)).rows;
  } finally {
    await client.end();
  }

  const violations = auditRows(rows);
  if (violations.length === 0) {
    console.log(`✓ Политика FK на пользователя соблюдена: проверено ${rows.length} ключ(ей).`);
    process.exit(0);
  }

  console.error(`✗ Нарушений политики FK на пользователя: ${violations.length} (проверено ${rows.length})\n`);
  for (const v of violations) {
    console.error(`  ${v.key}  (${v.constraintName})`);
    console.error(`      ${v.reason}`);
    console.error(`      → ${v.fix}`);
  }
  console.error(
    '\nПолитика описана в docs/migrations/284_user_delete_tombstone.sql:\n' +
    '  own — CASCADE, author — SET DEFAULT на надгробие, keep_null — SET NULL по nullable-колонке.',
  );
  process.exit(1);
}

// Импорт из теста не должен поднимать подключение к БД.
if (process.argv[1] && process.argv[1].includes('audit-user-fk')) {
  main().catch((error) => {
    console.error('✗ Аудит не выполнен:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
