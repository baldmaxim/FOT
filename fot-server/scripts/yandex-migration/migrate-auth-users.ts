// Production-safe миграция Supabase Auth (source.auth.users) → app_auth.users
// (target). Использует прямой PG-коннект, поддерживает SSL с custom CA,
// DRY_RUN по умолчанию, UPSERT по id, отчёт о конфликтах lower(email).
//
// Использование:
//   npm run migrate:yandex:auth-users -- --help
//   npm run migrate:yandex:auth-users -- --dry-run
//   npm run migrate:yandex:auth-users -- --apply
//
// ENV:
//   SOURCE_DATABASE_URL       postgres://... (Supabase pg connection)
//   TARGET_DATABASE_URL       postgres://... (Yandex Managed PG)
//   SOURCE_SSL                'true' (default) | 'false'
//   TARGET_SSL                'true' (default) | 'false'
//   SOURCE_SSL_CA_PATH        путь к PEM CA (опционально)
//   TARGET_SSL_CA_PATH        путь к PEM CA (опционально, обычно нужен для YC)
//   DRY_RUN                   'true' (default) | 'false'  (CLI флаги имеют приоритет)
//   BATCH_SIZE                500 (default)
//
// Безопасность:
// - DRY_RUN по умолчанию true; запись возможна только через `--apply`.
// - Полный bcrypt-хеш НИКОГДА не пишется в лог/отчёт — только prefix + длина.
// - Конфликт lower(email) с другим id → отчёт + non-zero exit.
// - SSL включён по умолчанию, rejectUnauthorized=true; CA подгружается из
//   *_SSL_CA_PATH, если задан.

import fs from 'fs';
import path from 'path';
import { Client, type ClientConfig } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Типы / константы
// ─────────────────────────────────────────────────────────────────────────────

const BCRYPT_PREFIX_RE = /^\$2[aby]\$\d{2}\$/;
const MIGRATED_FROM_TAG = 'supabase_auth';
const REPORT_DIR = '.migration';
const REPORT_JSON = path.join(REPORT_DIR, 'auth_users_report.json');
const REPORT_MD = path.join(REPORT_DIR, 'auth_users_report.md');
const SAMPLE_VERIFY_COUNT = 5;
const SAMPLE_LIST_LIMIT = 10;

interface ICliArgs {
  dryRun: boolean | undefined;
  help: boolean;
}

interface IMigrationConfig {
  sourceUrl: string;
  targetUrl: string;
  sourceSsl: ClientConfig['ssl'];
  targetSsl: ClientConfig['ssl'];
  dryRun: boolean;
  batchSize: number;
}

interface ISourceUserRow {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
}

interface IConflictRow {
  sourceId: string;
  sourceEmail: string;
  targetId: string;
  targetEmail: string;
}

interface ISampleRow {
  id: string;
  email: string;
  reason: string;
}

interface IVerificationSample {
  id: string;
  email: string;
  fieldsMatch: {
    email: boolean;
    email_confirmed_at: boolean;
    hash_prefix_length: boolean;
  };
  sourceHashSnapshot: string;
  targetHashSnapshot: string;
}

interface IReport {
  startedAt: string;
  finishedAt: string;
  mode: 'dry-run' | 'apply';
  config: { batchSize: number };
  counts: {
    source: number;
    targetBefore: number;
    targetAfter: number;
    processed: number;
    inserted: number;
    updated: number;
    skippedNoEmail: number;
    skippedPasswordless: number;
    skippedUnsupportedHash: number;
  };
  conflicts: IConflictRow[];
  passwordlessSamples: ISampleRow[];
  unsupportedHashSamples: ISampleRow[];
  verifications: IVerificationSample[];
  exitCode: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI / ENV
// ─────────────────────────────────────────────────────────────────────────────

const HELP_TEXT = `migrate-auth-users — перенос Supabase Auth users в app_auth.users

Usage:
  npm run migrate:yandex:auth-users -- [--dry-run|--apply] [--help]

Flags:
  --dry-run    Прогон без записи (по умолчанию через ENV DRY_RUN=true)
  --apply      Реальная запись в TARGET_DATABASE_URL
  -h, --help   Эта справка

ENV:
  SOURCE_DATABASE_URL    postgres://...  Supabase (source)
  TARGET_DATABASE_URL    postgres://...  Yandex Managed PG (target)
  SOURCE_SSL             true|false      default: true
  TARGET_SSL             true|false      default: true
  SOURCE_SSL_CA_PATH     /path/to/ca.pem (optional)
  TARGET_SSL_CA_PATH     /path/to/ca.pem (optional, обычно нужен для YC)
  DRY_RUN                true|false      default: true (CLI флаги имеют приоритет)
  BATCH_SIZE             integer         default: 500

Поведение:
  - source: SELECT FROM auth.users (Supabase Auth schema)
  - target: UPSERT INTO app_auth.users (миграция 088)
  - skip: users без email; users без encrypted_password / с unsupported hash → в отчёт
  - конфликт lower(email) под другим id → отчёт + exit 1
  - отчёты: .migration/auth_users_report.{json,md}
`;

function parseArgs(argv: readonly string[]): ICliArgs {
  let dryRun: boolean | undefined;
  let help = false;
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--dry-run') {
      if (dryRun === false) {
        throw new Error('Нельзя указать одновременно --dry-run и --apply');
      }
      dryRun = true;
    } else if (a === '--apply') {
      if (dryRun === true) {
        throw new Error('Нельзя указать одновременно --dry-run и --apply');
      }
      dryRun = false;
    } else {
      throw new Error(`Неизвестный аргумент: ${a}. Используйте --help.`);
    }
  }
  return { dryRun, help };
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function envInt(name: string, fallback: number, min = 1, max = 10_000): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`ENV ${name} должна быть integer в диапазоне [${min}, ${max}], получено: ${raw}`);
  }
  return parsed;
}

function buildSsl(prefix: 'SOURCE' | 'TARGET'): ClientConfig['ssl'] {
  const enabled = envFlag(`${prefix}_SSL`, true);
  if (!enabled) return false;
  const caPath = process.env[`${prefix}_SSL_CA_PATH`];
  if (caPath) {
    const resolved = path.resolve(caPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`${prefix}_SSL_CA_PATH указан, но файл не найден: ${resolved}`);
    }
    return { rejectUnauthorized: true, ca: fs.readFileSync(resolved, 'utf8') };
  }
  return { rejectUnauthorized: true };
}

function resolveConfig(args: ICliArgs): IMigrationConfig {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl) throw new Error('SOURCE_DATABASE_URL не задан');
  if (!targetUrl) throw new Error('TARGET_DATABASE_URL не задан');

  const dryRun = args.dryRun ?? envFlag('DRY_RUN', true);
  const batchSize = envInt('BATCH_SIZE', 500);

  return {
    sourceUrl,
    targetUrl,
    sourceSsl: buildSsl('SOURCE'),
    targetSsl: buildSsl('TARGET'),
    dryRun,
    batchSize,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────────────────────

const redactHash = (h: string | null | undefined): string => {
  if (!h) return '(none)';
  // Никогда не возвращаем полный хеш. Только prefix до соли и длину.
  const prefix = h.length >= 7 ? h.slice(0, 7) : h.slice(0, h.length);
  return `${prefix}… (${h.length} chars)`;
};

const isBcryptHash = (h: string | null | undefined): boolean =>
  !!h && BCRYPT_PREFIX_RE.test(h);

const normalizeEmail = (e: string | null | undefined): string =>
  typeof e === 'string' ? e.trim().toLowerCase() : '';

// Случайная подвыборка N элементов без замены.
function sampleWithoutReplacement<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const indexes = new Set<number>();
  while (indexes.size < n) {
    indexes.add(Math.floor(Math.random() * arr.length));
  }
  return [...indexes].sort((a, b) => a - b).map(i => arr[i]);
}

// ─────────────────────────────────────────────────────────────────────────────
// БД-операции
// ─────────────────────────────────────────────────────────────────────────────

async function getSourceCount(source: Client): Promise<number> {
  const { rows } = await source.query<{ c: string }>(
    'SELECT count(*)::text AS c FROM auth.users',
  );
  return Number.parseInt(rows[0].c, 10);
}

async function getTargetCount(target: Client): Promise<number> {
  const { rows } = await target.query<{ c: string }>(
    'SELECT count(*)::text AS c FROM app_auth.users',
  );
  return Number.parseInt(rows[0].c, 10);
}

async function loadTargetEmailIndex(target: Client): Promise<Map<string, string>> {
  // lower(email) → id (для детектирования конфликтов).
  const { rows } = await target.query<{ id: string; email: string }>(
    'SELECT id, email FROM app_auth.users',
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(normalizeEmail(r.email), r.id);
  }
  return map;
}

interface IUpsertOutcome {
  inserted: boolean;
}

async function upsertUser(target: Client, src: ISourceUserRow): Promise<IUpsertOutcome> {
  const sql = `
    INSERT INTO app_auth.users (
      id, email, password_hash, email_confirmed_at, last_sign_in_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      migrated_from, migrated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, now())
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      password_hash = EXCLUDED.password_hash,
      email_confirmed_at = EXCLUDED.email_confirmed_at,
      last_sign_in_at = EXCLUDED.last_sign_in_at,
      raw_app_meta_data = EXCLUDED.raw_app_meta_data,
      raw_user_meta_data = EXCLUDED.raw_user_meta_data,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      migrated_from = EXCLUDED.migrated_from,
      migrated_at = EXCLUDED.migrated_at
    RETURNING (xmax = 0) AS inserted
  `;
  const params = [
    src.id,
    normalizeEmail(src.email),
    src.encrypted_password,
    src.email_confirmed_at,
    src.last_sign_in_at,
    JSON.stringify(src.raw_app_meta_data ?? {}),
    JSON.stringify(src.raw_user_meta_data ?? {}),
    src.created_at,
    src.updated_at ?? src.created_at,
    MIGRATED_FROM_TAG,
  ];
  const { rows } = await target.query<{ inserted: boolean }>(sql, params);
  return { inserted: rows[0]?.inserted ?? false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Главная процедура
// ─────────────────────────────────────────────────────────────────────────────

async function run(args: ICliArgs): Promise<number> {
  const startedAt = new Date().toISOString();
  const cfg = resolveConfig(args);

  console.log(`mode: ${cfg.dryRun ? 'dry-run' : 'APPLY'}`);
  console.log(`batchSize: ${cfg.batchSize}`);

  const source = new Client({ connectionString: cfg.sourceUrl, ssl: cfg.sourceSsl });
  const target = new Client({ connectionString: cfg.targetUrl, ssl: cfg.targetSsl });

  await source.connect();
  await target.connect();

  const report: IReport = {
    startedAt,
    finishedAt: '',
    mode: cfg.dryRun ? 'dry-run' : 'apply',
    config: { batchSize: cfg.batchSize },
    counts: {
      source: 0,
      targetBefore: 0,
      targetAfter: 0,
      processed: 0,
      inserted: 0,
      updated: 0,
      skippedNoEmail: 0,
      skippedPasswordless: 0,
      skippedUnsupportedHash: 0,
    },
    conflicts: [],
    passwordlessSamples: [],
    unsupportedHashSamples: [],
    verifications: [],
    exitCode: 0,
  };

  try {
    report.counts.source = await getSourceCount(source);
    report.counts.targetBefore = await getTargetCount(target);
    console.log(`source.auth.users: ${report.counts.source}`);
    console.log(`target.app_auth.users (before): ${report.counts.targetBefore}`);

    // Загружаем существующий target email-index до обработки — он определяет
    // потенциальные конфликты lower(email).
    const targetEmailIndex = await loadTargetEmailIndex(target);

    // Стримим source через серверный курсор (читать всё в память небезопасно
    // на больших инстансах).
    await source.query('BEGIN');
    await source.query(`
      DECLARE auth_users_cur NO SCROLL CURSOR FOR
        SELECT id, email, encrypted_password,
               email_confirmed_at, last_sign_in_at,
               raw_app_meta_data, raw_user_meta_data,
               created_at, updated_at
          FROM auth.users
         ORDER BY created_at ASC, id ASC
    `);

    // Для верификации запоминаем успешно обработанные id.
    const processedIds: string[] = [];
    // Для verification — храним source-snapshot чтобы сравнить с target после.
    const processedSnapshots = new Map<
      string,
      { email: string; emailConfirmedAt: string | null; hashLen: number; hashPrefix: string }
    >();

    while (true) {
      const { rows } = await source.query<ISourceUserRow>(
        `FETCH ${cfg.batchSize} FROM auth_users_cur`,
      );
      if (rows.length === 0) break;

      for (const src of rows) {
        report.counts.processed++;

        // 1. email обязателен
        if (!src.email || !normalizeEmail(src.email)) {
          report.counts.skippedNoEmail++;
          continue;
        }
        const lowerEmail = normalizeEmail(src.email);

        // 2. password_hash обязателен
        if (!src.encrypted_password || src.encrypted_password.length === 0) {
          report.counts.skippedPasswordless++;
          if (report.passwordlessSamples.length < SAMPLE_LIST_LIMIT) {
            report.passwordlessSamples.push({
              id: src.id,
              email: lowerEmail,
              reason: 'encrypted_password is NULL/empty in source.auth.users',
            });
          }
          continue;
        }

        // 3. bcrypt prefix check
        if (!isBcryptHash(src.encrypted_password)) {
          report.counts.skippedUnsupportedHash++;
          if (report.unsupportedHashSamples.length < SAMPLE_LIST_LIMIT) {
            report.unsupportedHashSamples.push({
              id: src.id,
              email: lowerEmail,
              reason: `unsupported hash format: ${redactHash(src.encrypted_password)}`,
            });
          }
          continue;
        }

        // 4. конфликт lower(email) с другим id
        const existingTargetId = targetEmailIndex.get(lowerEmail);
        if (existingTargetId && existingTargetId !== src.id) {
          report.conflicts.push({
            sourceId: src.id,
            sourceEmail: src.email,
            targetId: existingTargetId,
            targetEmail: lowerEmail,
          });
          continue;
        }

        // 5. UPSERT (если apply)
        if (cfg.dryRun) {
          // В dry-run не пишем, но считаем как «было бы вставлено».
          report.counts.inserted++;
        } else {
          try {
            const { inserted } = await upsertUser(target, src);
            if (inserted) report.counts.inserted++;
            else report.counts.updated++;
            // Обновляем локальный индекс, чтобы последующие батчи видели новую запись.
            targetEmailIndex.set(lowerEmail, src.id);
          } catch (err) {
            // Ошибка БД на конкретной строке — продолжаем, но фиксируем.
            // Полный stack только в stderr, в отчёт — короткое описание.
            const code = (err as { code?: string })?.code ?? 'UNKNOWN';
            console.error(
              `[migrate-auth-users] upsert error id=${src.id} code=${code}:`,
              err instanceof Error ? err.message : String(err),
            );
            // 23505 на UNIQUE lower(email) — race-конфликт, в отчёт.
            if (code === '23505') {
              report.conflicts.push({
                sourceId: src.id,
                sourceEmail: src.email,
                targetId: existingTargetId ?? '(unknown, race condition)',
                targetEmail: lowerEmail,
              });
            } else {
              throw err;
            }
          }
        }

        processedIds.push(src.id);
        processedSnapshots.set(src.id, {
          email: lowerEmail,
          emailConfirmedAt: src.email_confirmed_at,
          hashLen: src.encrypted_password.length,
          hashPrefix: src.encrypted_password.slice(0, 7),
        });
      }

      console.log(
        `[batch] processed=${report.counts.processed} inserted=${report.counts.inserted} ` +
          `updated=${report.counts.updated} conflicts=${report.conflicts.length}`,
      );
    }

    await source.query('CLOSE auth_users_cur');
    await source.query('COMMIT');

    // Подсчёт target после.
    report.counts.targetAfter = await getTargetCount(target);

    // Verification: 5 случайных users — сравнить source vs target.
    const verifyIds = sampleWithoutReplacement(processedIds, SAMPLE_VERIFY_COUNT);
    if (verifyIds.length > 0 && !cfg.dryRun) {
      const { rows: targetRows } = await target.query<{
        id: string;
        email: string;
        email_confirmed_at: string | null;
        password_hash: string;
      }>(
        `SELECT id, email, email_confirmed_at, password_hash
           FROM app_auth.users
          WHERE id = ANY($1::uuid[])`,
        [verifyIds],
      );
      const targetById = new Map(targetRows.map(r => [r.id, r]));
      for (const id of verifyIds) {
        const src = processedSnapshots.get(id);
        const tgt = targetById.get(id);
        if (!src || !tgt) continue;
        report.verifications.push({
          id,
          email: src.email,
          fieldsMatch: {
            email: tgt.email === src.email,
            email_confirmed_at:
              (tgt.email_confirmed_at ?? null) === (src.emailConfirmedAt ?? null),
            hash_prefix_length:
              tgt.password_hash.length === src.hashLen &&
              tgt.password_hash.slice(0, 7) === src.hashPrefix,
          },
          sourceHashSnapshot: `${src.hashPrefix}… (${src.hashLen} chars)`,
          targetHashSnapshot: redactHash(tgt.password_hash),
        });
      }
    } else if (verifyIds.length > 0 && cfg.dryRun) {
      // В dry-run просто отметим source-snapshots (target не трогаем).
      for (const id of verifyIds) {
        const src = processedSnapshots.get(id);
        if (!src) continue;
        report.verifications.push({
          id,
          email: src.email,
          fieldsMatch: { email: false, email_confirmed_at: false, hash_prefix_length: false },
          sourceHashSnapshot: `${src.hashPrefix}… (${src.hashLen} chars)`,
          targetHashSnapshot: '(dry-run: target не записан)',
        });
      }
    }

    if (report.conflicts.length > 0) {
      report.exitCode = 1;
    }
  } catch (err) {
    console.error('[migrate-auth-users] fatal error:', err instanceof Error ? err.stack : err);
    report.exitCode = 2;
    try {
      await source.query('ROLLBACK');
    } catch {
      // ignore — курсор мог не открыться
    }
  } finally {
    await source.end().catch(() => undefined);
    await target.end().catch(() => undefined);
  }

  report.finishedAt = new Date().toISOString();
  writeReports(report);

  console.log('\n─── итог ───');
  console.log(`mode: ${report.mode}`);
  console.log(`source: ${report.counts.source}`);
  console.log(`target before: ${report.counts.targetBefore}`);
  console.log(`target after: ${report.counts.targetAfter}`);
  console.log(
    `processed=${report.counts.processed} ` +
      `inserted=${report.counts.inserted} updated=${report.counts.updated}`,
  );
  console.log(
    `skipped: noEmail=${report.counts.skippedNoEmail} ` +
      `passwordless=${report.counts.skippedPasswordless} ` +
      `unsupportedHash=${report.counts.skippedUnsupportedHash}`,
  );
  console.log(`conflicts: ${report.conflicts.length}`);
  console.log(`report: ${REPORT_JSON} / ${REPORT_MD}`);

  return report.exitCode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Отчёты
// ─────────────────────────────────────────────────────────────────────────────

function writeReports(report: IReport): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(REPORT_MD, renderMarkdown(report), 'utf8');
}

function renderMarkdown(r: IReport): string {
  const sumOk =
    r.counts.targetAfter === r.counts.targetBefore + r.counts.inserted ||
    r.mode === 'dry-run';
  const lines: string[] = [];
  lines.push('# migrate-auth-users report');
  lines.push('');
  lines.push(`- Mode: **${r.mode}**`);
  lines.push(`- Started: ${r.startedAt}`);
  lines.push(`- Finished: ${r.finishedAt}`);
  lines.push(`- Exit code: ${r.exitCode}`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| source.auth.users | ${r.counts.source} |`);
  lines.push(`| target.app_auth.users (before) | ${r.counts.targetBefore} |`);
  lines.push(`| target.app_auth.users (after) | ${r.counts.targetAfter} |`);
  lines.push(`| processed | ${r.counts.processed} |`);
  lines.push(`| inserted | ${r.counts.inserted} |`);
  lines.push(`| updated | ${r.counts.updated} |`);
  lines.push(`| skipped: no email | ${r.counts.skippedNoEmail} |`);
  lines.push(`| skipped: passwordless | ${r.counts.skippedPasswordless} |`);
  lines.push(`| skipped: unsupported hash | ${r.counts.skippedUnsupportedHash} |`);
  lines.push(`| conflicts | ${r.conflicts.length} |`);
  lines.push(`| target delta consistent | ${sumOk ? 'yes' : 'NO'} |`);
  lines.push('');
  if (r.conflicts.length > 0) {
    lines.push('## ⚠ Conflicts (lower(email) совпадает с другим id)');
    lines.push('');
    lines.push('| Source ID | Source Email | Target ID | Target Email |');
    lines.push('|---|---|---|---|');
    for (const c of r.conflicts.slice(0, 50)) {
      lines.push(
        `| ${c.sourceId} | ${c.sourceEmail} | ${c.targetId} | ${c.targetEmail} |`,
      );
    }
    if (r.conflicts.length > 50) {
      lines.push('');
      lines.push(`_… +${r.conflicts.length - 50} more, см. JSON-отчёт._`);
    }
    lines.push('');
  }
  if (r.passwordlessSamples.length > 0) {
    lines.push('## Passwordless users (skipped)');
    lines.push('');
    lines.push('| ID | Email | Reason |');
    lines.push('|---|---|---|');
    for (const s of r.passwordlessSamples) {
      lines.push(`| ${s.id} | ${s.email} | ${s.reason} |`);
    }
    lines.push('');
  }
  if (r.unsupportedHashSamples.length > 0) {
    lines.push('## Unsupported hash format (skipped)');
    lines.push('');
    lines.push('| ID | Email | Reason |');
    lines.push('|---|---|---|');
    for (const s of r.unsupportedHashSamples) {
      lines.push(`| ${s.id} | ${s.email} | ${s.reason} |`);
    }
    lines.push('');
  }
  if (r.verifications.length > 0) {
    lines.push('## Sample verification (random 5)');
    lines.push('');
    lines.push('Хеши никогда не показываются целиком — только prefix + длина.');
    lines.push('');
    lines.push('| ID | Email | email = | email_confirmed_at = | hash prefix+len = | source hash | target hash |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const v of r.verifications) {
      lines.push(
        `| ${v.id} | ${v.email} | ${v.fieldsMatch.email ? '✓' : '✗'} | ` +
          `${v.fieldsMatch.email_confirmed_at ? '✓' : '✗'} | ` +
          `${v.fieldsMatch.hash_prefix_length ? '✓' : '✗'} | ` +
          `${v.sourceHashSnapshot} | ${v.targetHashSnapshot} |`,
      );
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('Полный отчёт: `.migration/auth_users_report.json`');
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: ICliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error('\n' + HELP_TEXT);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  try {
    const exitCode = await run(args);
    process.exit(exitCode);
  } catch (err) {
    console.error('[migrate-auth-users] uncaught error:', err instanceof Error ? err.stack : err);
    process.exit(2);
  }
}

void main();
