// validate-auth-fks.ts
//
// Полный жизненный цикл 5 secondary FK на app_auth.users(id), которые
// в боевом Supabase ссылались на auth.users. Главный FK
// user_profiles_id_fkey_app_auth обслуживает отдельный скрипт
// validate-auth-fk.ts (см. 13-й шаг ран-бука 05_public_data.md).
//
// Запускается ПОСЛЕ:
//   1) restore-public-data.sh (public-данные на target);
//   2) migrate-auth-users -- --apply (app_auth.users заполнена);
//   3) необязательно — apply 089_yandex_auth_user_fks.sql (создаёт FK
//      NOT VALID); скрипт сам создаст недостающие.
//
// Шаги (идемпотентно):
//   1. Sanity: app_auth.users + 5 public-таблиц существуют.
//   2. Для каждого из 5 FK:
//      a. Orphan-check: column IS NOT NULL AND NOT EXISTS app_auth.users(id).
//         Печать первых 20 при наличии.
//         Если orphans > 0 — FK для этой колонки помечается failed; не
//         валидируется, не создаётся.
//      b. Если orphans == 0:
//         - drop legacy FK на auth.users (одноразовый cleanup);
//         - если FK на app_auth.users отсутствует — CREATE … NOT VALID;
//         - VALIDATE CONSTRAINT;
//         - post-check pg_constraint.convalidated = true.
//   3. Aggregate: если хоть один FK не validated — exit 1.
//
// Атрибуты FK (ON DELETE / ON UPDATE / DEFERRABLE / MATCH) сняты с боевой
// Supabase через pg_get_constraintdef — см. STAGING_REHEARSAL_REPORT.md
// Finding 2.

import fs from 'node:fs';
import path from 'node:path';
import { Client, type ClientConfig } from 'pg';

const ORPHAN_SAMPLE_LIMIT = 20;

interface IFkSpec {
  conname: string;
  table: string;          // table name in `public` schema
  column: string;
  /** ON DELETE action. NO ACTION = default, можно опускать в DDL. */
  onDelete: 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT';
  /** Один column в каждом FK — single-column (подтверждено source). */
}

const FKS: readonly IFkSpec[] = [
  { conname: 'user_profiles_approved_by_fkey',        table: 'user_profiles',        column: 'approved_by', onDelete: 'NO ACTION' },
  { conname: 'audit_logs_user_id_fkey',               table: 'audit_logs',           column: 'user_id',     onDelete: 'NO ACTION' },
  { conname: 'employee_assignments_created_by_fkey',  table: 'employee_assignments', column: 'created_by',  onDelete: 'NO ACTION' },
  { conname: 'fk_push_subscriptions_user',            table: 'push_subscriptions',   column: 'user_id',     onDelete: 'CASCADE' },
  { conname: 'tender_salary_history_created_by_fkey', table: 'salary_history',       column: 'created_by',  onDelete: 'NO ACTION' },
];

interface IArgs {
  help: boolean;
  skipValidate: boolean;
  checkOnly: boolean;
}

const HELP = `validate-auth-fks — управление 5 secondary FK public.* → app_auth.users(id)

Usage:
  npm run migrate:yandex:validate-auth-fks -- [--skip-validate | --check-only]

ENV:
  TARGET_DATABASE_URL   postgres://...  (required) — Yandex Managed PG
  TARGET_SSL            true|false (default: true)
  TARGET_SSL_CA_PATH    /path/to/ca.pem (optional)

5 FK (атрибуты из source через pg_get_constraintdef):
  user_profiles_approved_by_fkey         (approved_by, ON DELETE NO ACTION)
  audit_logs_user_id_fkey                (user_id,     ON DELETE NO ACTION)
  employee_assignments_created_by_fkey   (created_by,  ON DELETE NO ACTION)
  fk_push_subscriptions_user             (user_id,     ON DELETE CASCADE)
  tender_salary_history_created_by_fkey  (created_by,  ON DELETE NO ACTION)

Главный FK user_profiles_id_fkey_app_auth — отдельный скрипт
migrate:yandex:validate-auth-fk (без \`s\`).

Что делает (default, для каждого из 5 FK):
  1. sanity (app_auth.users + public.<table> существуют);
  2. orphan-check: count rows с column IS NOT NULL и no match в
     app_auth.users; печатает первые ${ORPHAN_SAMPLE_LIMIT};
  3. если orphans > 0 — FK помечается failed (не валидируется);
  4. если orphans == 0:
       - drop legacy FK на auth.users (если остался),
       - CREATE FK ... NOT VALID если отсутствует,
       - VALIDATE CONSTRAINT,
       - post-check pg_constraint.convalidated = true.

Флаги:
  --skip-validate   Делать всё, кроме финального VALIDATE CONSTRAINT.
  --check-only      Только проверки (sanity + orphans + статусы); без
                    модификаций БД (для CI / pre-deploy).

Exit codes:
  0 — все 5 FK validated (convalidated=true)
  1 — orphans > 0 хотя бы по одному FK ИЛИ ошибка БД ИЛИ post-check провалился
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

async function fkExists(client: Client, conname: string, qualified: string): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = $1 AND conrelid = $2::regclass
     ) AS exists;`,
    [conname, qualified],
  );
  return r.rows[0]?.exists ?? false;
}

async function fkIsValidated(client: Client, conname: string, qualified: string): Promise<boolean> {
  const r = await client.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint
       WHERE conname = $1 AND conrelid = $2::regclass;`,
    [conname, qualified],
  );
  return r.rows[0]?.convalidated ?? false;
}

async function dropLegacyFk(client: Client, conname: string, table: string): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace ns ON ns.oid = t.relnamespace
         JOIN pg_class ft ON ft.oid = c.confrelid
         JOIN pg_namespace fns ON fns.oid = ft.relnamespace
        WHERE c.contype = 'f'
          AND c.conname = $1
          AND ns.nspname = 'public' AND t.relname = $2
          AND fns.nspname = 'auth' AND ft.relname = 'users'
     ) AS exists;`,
    [conname, table],
  );
  if (!r.rows[0]?.exists) return false;
  await client.query(`ALTER TABLE public."${table}" DROP CONSTRAINT "${conname}";`);
  return true;
}

interface IFkResult {
  conname: string;
  table: string;
  column: string;
  status: 'validated' | 'failed_orphans' | 'failed_db_error' | 'skipped_validate' | 'skipped_check_only';
  orphans: number;
  message?: string;
}

async function processFk(
  client: Client,
  fk: IFkSpec,
  args: IArgs,
): Promise<IFkResult> {
  const qualified = `public.${fk.table}`;

  // 0. Sanity
  if (!(await checkTable(client, 'public', fk.table))) {
    return { conname: fk.conname, table: fk.table, column: fk.column, status: 'failed_db_error', orphans: 0,
      message: `public.${fk.table} не существует` };
  }

  // 1. Orphan-check (NULL-safe — single column FK с NULL не нарушает FK)
  let orphans = 0;
  try {
    const r = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c
         FROM public."${fk.table}" t
        WHERE t."${fk.column}" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM app_auth.users a WHERE a.id = t."${fk.column}");`,
    );
    orphans = Number.parseInt(r.rows[0]?.c ?? '0', 10);
  } catch (err) {
    return { conname: fk.conname, table: fk.table, column: fk.column, status: 'failed_db_error', orphans: 0,
      message: (err as Error).message };
  }

  console.log(`[${fk.conname}] orphans=${orphans}`);

  if (orphans > 0) {
    const sample = await client.query<{ value: string }>(
      `SELECT DISTINCT t."${fk.column}"::text AS value
         FROM public."${fk.table}" t
        WHERE t."${fk.column}" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM app_auth.users a WHERE a.id = t."${fk.column}")
        LIMIT $1;`,
      [ORPHAN_SAMPLE_LIMIT],
    );
    console.error(`  Первые ${ORPHAN_SAMPLE_LIMIT} orphan-значений public.${fk.table}.${fk.column}:`);
    for (const r of sample.rows) {
      console.error(`    - ${r.value}`);
    }
    return { conname: fk.conname, table: fk.table, column: fk.column, status: 'failed_orphans', orphans,
      message: `${orphans} orphan-строк; FK не валидирован` };
  }

  // 2. check-only mode — без модификаций
  if (args.checkOnly) {
    const exists = await fkExists(client, fk.conname, qualified);
    if (exists) {
      const v = await fkIsValidated(client, fk.conname, qualified);
      return { conname: fk.conname, table: fk.table, column: fk.column,
        status: 'skipped_check_only', orphans: 0,
        message: `FK существует, convalidated=${v}` };
    }
    return { conname: fk.conname, table: fk.table, column: fk.column,
      status: 'skipped_check_only', orphans: 0,
      message: 'FK отсутствует (нужно создать)' };
  }

  // 3. Drop legacy FK на auth.users (одноразовый cleanup)
  try {
    const dropped = await dropLegacyFk(client, fk.conname, fk.table);
    if (dropped) {
      console.log(`  Dropped legacy FK ${fk.conname} → auth.users`);
    }
  } catch (err) {
    return { conname: fk.conname, table: fk.table, column: fk.column, status: 'failed_db_error', orphans: 0,
      message: `Drop legacy failed: ${(err as Error).message}` };
  }

  // 4. Create FK if missing
  const exists = await fkExists(client, fk.conname, qualified);
  if (!exists) {
    const onDeleteClause = fk.onDelete === 'NO ACTION' ? '' : ` ON DELETE ${fk.onDelete}`;
    try {
      await client.query(
        `ALTER TABLE public."${fk.table}"
           ADD CONSTRAINT "${fk.conname}"
           FOREIGN KEY ("${fk.column}") REFERENCES app_auth.users(id)${onDeleteClause}
           NOT VALID;`,
      );
      console.log(`  Created NOT VALID FK ${fk.conname}`);
    } catch (err) {
      return { conname: fk.conname, table: fk.table, column: fk.column, status: 'failed_db_error', orphans: 0,
        message: `ADD CONSTRAINT failed: ${(err as Error).message}` };
    }
  } else {
    console.log(`  FK ${fk.conname} уже существует`);
  }

  // 5. VALIDATE
  if (args.skipValidate) {
    return { conname: fk.conname, table: fk.table, column: fk.column,
      status: 'skipped_validate', orphans: 0,
      message: '--skip-validate: VALIDATE пропущен' };
  }

  try {
    const before = await fkIsValidated(client, fk.conname, qualified);
    if (!before) {
      await client.query(`ALTER TABLE public."${fk.table}" VALIDATE CONSTRAINT "${fk.conname}";`);
    }
    const after = await fkIsValidated(client, fk.conname, qualified);
    if (!after) {
      return { conname: fk.conname, table: fk.table, column: fk.column, status: 'failed_db_error', orphans: 0,
        message: 'post-check pg_constraint.convalidated=false после VALIDATE — race condition?' };
    }
    return { conname: fk.conname, table: fk.table, column: fk.column,
      status: 'validated', orphans: 0,
      message: `convalidated=true${before ? ' (already validated)' : ''}` };
  } catch (err) {
    return { conname: fk.conname, table: fk.table, column: fk.column, status: 'failed_db_error', orphans: 0,
      message: `VALIDATE failed: ${(err as Error).message}` };
  }
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
    // Pre-flight sanity
    if (!(await checkTable(client, 'app_auth', 'users'))) {
      console.error('ERROR: app_auth.users отсутствует. Примените docs/migrations/088_yandex_app_auth.sql.');
      process.exit(2);
    }

    const results: IFkResult[] = [];
    for (const fk of FKS) {
      results.push(await processFk(client, fk, args));
    }

    console.log('\n─── Итог по 5 FK ───');
    for (const r of results) {
      const icon = r.status === 'validated' ? '✓'
                 : r.status.startsWith('skipped') ? '–'
                 : '✗';
      console.log(`  ${icon} ${r.conname.padEnd(40)} status=${r.status}${r.message ? ` (${r.message})` : ''}`);
    }

    const failed = results.filter(r => r.status === 'failed_orphans' || r.status === 'failed_db_error');
    process.exit(failed.length > 0 ? 1 : 0);
  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
