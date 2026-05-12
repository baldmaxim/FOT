// validate-auth-fk.ts
//
// Полный жизненный цикл FK public.user_profiles(id) → app_auth.users(id).
// Запускается ПОСЛЕ restore public data + backfill app_auth.users.
//
// Шаги (идемпотентно, безопасно повторно):
//   1. Sanity: app_auth.users существует (088 применена),
//              public.user_profiles существует (pre-data schema применена).
//   2. Поиск orphans: строки в public.user_profiles, у которых нет
//      соответствующего id в app_auth.users.
//   3. Если orphans > 0 — печатаем первые 20 и exit 1, ничего не меняем.
//   4. Если orphans == 0:
//      a. Если FK user_profiles_id_fkey_app_auth ОТСУТСТВУЕТ —
//         сначала чистим возможный legacy FK на auth.users (idempotent),
//         затем CREATE FK ... NOT VALID.
//      b. Запускаем ALTER TABLE ... VALIDATE CONSTRAINT (idempotent —
//         на уже валидированном FK PG возвращает success без работы).
//
// Запуск из fot-server:
//   npm run migrate:yandex:validate-auth-fk
//
// Использует pg-driver напрямую. SSL — из TARGET_SSL / TARGET_SSL_CA_PATH,
// те же ENV, что у migrate-auth-users.ts.

import fs from 'node:fs';
import path from 'node:path';
import { Client, type ClientConfig } from 'pg';

const FK_NAME = 'user_profiles_id_fkey_app_auth';
const ORPHAN_SAMPLE_LIMIT = 20;

interface IArgs {
  help: boolean;
  skipValidate: boolean;
  checkOnly: boolean;
}

const HELP = `validate-auth-fk — управление FK public.user_profiles → app_auth.users

Usage:
  npm run migrate:yandex:validate-auth-fk -- [--skip-validate | --check-only]

ENV:
  TARGET_DATABASE_URL   postgres://...  (required) — Yandex Managed PG
  TARGET_SSL            true|false (default: true)
  TARGET_SSL_CA_PATH    /path/to/ca.pem (optional)

Что делает (default):
  1. Проверяет, что app_auth.users и public.user_profiles существуют.
  2. Считает orphans (user_profiles.id без записи в app_auth.users).
     Печатает первые ${ORPHAN_SAMPLE_LIMIT} при наличии.
  3. Если orphans > 0 — exit 1 без модификаций (значит migrate-auth-users
     не довёз кого-то; повторите backfill).
  4. Если orphans == 0:
     - удаляет любой legacy FK public.user_profiles → auth.users (idempotent
       одноразовый cleanup; на Yandex его обычно нет);
     - если FK ${FK_NAME} отсутствует — CREATE ... NOT VALID;
     - выполняет ALTER TABLE ... VALIDATE CONSTRAINT (no-op, если уже
       validated).

Флаги:
  --skip-validate   Делать всё, кроме финального VALIDATE CONSTRAINT
                    (полезно при поэтапной выкатке).
  --check-only      Только проверки (sanity + orphans + статус FK), никаких
                    модификаций БД. Подходит для CI / pre-deploy.

Exit codes:
  0 — успешно (orphans=0, FK создан/обновлён по плану)
  1 — orphans > 0 ИЛИ ошибка БД при выполнении шага
  2 — ENV / коннект / sanity не прошли
`;

function parseArgs(argv: readonly string[]): IArgs {
  const out: IArgs = { help: false, skipValidate: false, checkOnly: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--skip-validate') out.skipValidate = true;
    else if (a === '--check-only') out.checkOnly = true;
    else throw new Error(`Неизвестный аргумент: ${a}`);
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
      throw new Error(`TARGET_SSL_CA_PATH задан, но файл не найден: ${resolved}`);
    }
    return { rejectUnauthorized: true, ca: fs.readFileSync(resolved, 'utf8') };
  }
  return { rejectUnauthorized: true };
}

async function checkTable(client: Client, schema: string, table: string): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
     ) AS exists;`,
    [schema, table],
  );
  return r.rows[0]?.exists ?? false;
}

async function fkExists(client: Client, name: string): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = $1
          AND conrelid = 'public.user_profiles'::regclass
     ) AS exists;`,
    [name],
  );
  return r.rows[0]?.exists ?? false;
}

async function fkIsValidated(client: Client, name: string): Promise<boolean> {
  const r = await client.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint
       WHERE conname = $1 AND conrelid = 'public.user_profiles'::regclass;`,
    [name],
  );
  return r.rows[0]?.convalidated ?? false;
}

async function dropLegacyFks(client: Client): Promise<string[]> {
  // FK public.user_profiles → auth.users — наследие Supabase. На Yandex
  // схемы `auth` нет, поэтому запрос обычно возвращает 0 строк. Но если
  // оператор накатил Supabase schema-dump без транформера — возможны
  // остатки.
  const result = await client.query<{ conname: string }>(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_class t   ON t.oid  = c.conrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
       JOIN pg_class ft  ON ft.oid = c.confrelid
       JOIN pg_namespace fns ON fns.oid = ft.relnamespace
      WHERE c.contype = 'f'
        AND ns.nspname = 'public'
        AND t.relname  = 'user_profiles'
        AND fns.nspname = 'auth'
        AND ft.relname = 'users';`,
  );
  const dropped: string[] = [];
  for (const row of result.rows) {
    await client.query(`ALTER TABLE public.user_profiles DROP CONSTRAINT "${row.conname}";`);
    dropped.push(row.conname);
  }
  return dropped;
}

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
  if (args.skipValidate && args.checkOnly) {
    console.error('--skip-validate и --check-only взаимоисключающие.');
    process.exit(2);
  }

  const url = process.env.TARGET_DATABASE_URL;
  if (!url) {
    console.error('ERROR: TARGET_DATABASE_URL не задан');
    process.exit(2);
  }

  const client = new Client({ connectionString: url, ssl: buildSsl() });
  try {
    await client.connect();
  } catch (err) {
    console.error('ERROR: не удалось подключиться к TARGET:', (err as Error).message);
    process.exit(2);
  }

  try {
    // ─── 1. Sanity checks ───────────────────────────────────────────────
    if (!(await checkTable(client, 'app_auth', 'users'))) {
      console.error('ERROR: app_auth.users отсутствует. Сначала примените миграцию docs/migrations/088_yandex_app_auth.sql.');
      process.exit(2);
    }
    if (!(await checkTable(client, 'public', 'user_profiles'))) {
      console.error('ERROR: public.user_profiles отсутствует. Сначала примените pre-data schema (apply-yandex-schema.sh ...yandex_schema_pre_data.sql).');
      process.exit(2);
    }

    // ─── 2-3. Orphans ───────────────────────────────────────────────────
    const orphansResult = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c
         FROM public.user_profiles up
        WHERE NOT EXISTS (
          SELECT 1 FROM app_auth.users a WHERE a.id = up.id
        );`,
    );
    const orphans = Number.parseInt(orphansResult.rows[0]?.c ?? '0', 10);
    console.log(`user_profiles без app_auth.users: ${orphans}`);

    if (orphans > 0) {
      const sample = await client.query<{ id: string; full_name: string | null }>(
        `SELECT up.id, up.full_name
           FROM public.user_profiles up
           WHERE NOT EXISTS (
             SELECT 1 FROM app_auth.users a WHERE a.id = up.id
           )
           ORDER BY up.created_at NULLS LAST
           LIMIT $1;`,
        [ORPHAN_SAMPLE_LIMIT],
      );
      console.error(`\nORPHANS (первые ${ORPHAN_SAMPLE_LIMIT}):`);
      for (const r of sample.rows) {
        console.error(`  - ${r.id}  ${r.full_name ?? '(no full_name)'}`);
      }
      console.error('\nFK не изменялся. Повторите backfill (npm run migrate:yandex:auth-users -- --apply) и запустите валидацию снова.');
      process.exit(1);
    }

    // ─── 4a. FK создание (если нет) ─────────────────────────────────────
    const alreadyExists = await fkExists(client, FK_NAME);

    if (args.checkOnly) {
      if (alreadyExists) {
        const valid = await fkIsValidated(client, FK_NAME);
        console.log(`FK ${FK_NAME} существует. convalidated=${valid}.`);
      } else {
        console.log(`FK ${FK_NAME} отсутствует.`);
      }
      console.log('--check-only: модификаций не производилось.');
      process.exit(0);
    }

    if (!alreadyExists) {
      const droppedLegacy = await dropLegacyFks(client);
      for (const conname of droppedLegacy) {
        console.log(`Dropped legacy FK user_profiles → auth.users: ${conname}`);
      }
      await client.query(
        `ALTER TABLE public.user_profiles
           ADD CONSTRAINT ${FK_NAME}
           FOREIGN KEY (id) REFERENCES app_auth.users(id) ON DELETE CASCADE
           NOT VALID;`,
      );
      console.log(`Created FK ${FK_NAME} NOT VALID.`);
    } else {
      console.log(`FK ${FK_NAME} уже существует.`);
    }

    // ─── 4b. VALIDATE CONSTRAINT ───────────────────────────────────────
    if (args.skipValidate) {
      console.log('--skip-validate: VALIDATE CONSTRAINT пропущен.');
      process.exit(0);
    }

    const wasValidated = await fkIsValidated(client, FK_NAME);
    if (wasValidated) {
      console.log(`FK ${FK_NAME} уже validated — нечего делать.`);
      process.exit(0);
    }

    await client.query(
      `ALTER TABLE public.user_profiles VALIDATE CONSTRAINT ${FK_NAME};`,
    );

    // Post-VALIDATE проверка: убеждаемся, что pg_constraint.convalidated
    // действительно true. Защита от редкого edge-кейса, когда VALIDATE
    // отработал без exception, но constraint остался NOT VALID (например,
    // конкурентный DROP CONSTRAINT между нашим VALIDATE и проверкой).
    const finallyValidated = await fkIsValidated(client, FK_NAME);
    if (!finallyValidated) {
      console.error(
        `ERROR: после VALIDATE CONSTRAINT ${FK_NAME} в pg_constraint convalidated=false. ` +
          `Возможно, FK был сброшен или изменён конкурентно. Перезапустите скрипт.`,
      );
      process.exit(1);
    }

    console.log(`FK ${FK_NAME} validated (pg_constraint.convalidated=true).`);
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
