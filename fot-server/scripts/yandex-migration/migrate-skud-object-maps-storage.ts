// migrate-skud-object-maps-storage.ts
// Перенос файлов карты объектов СКУД из Supabase Storage в целевое
// S3-совместимое хранилище (Yandex Object Storage / AWS S3 / R2 / MinIO).
//
// Источник:  bucket `skud-object-maps` в Supabase Storage; пути берутся из
//            source PG (`SELECT id, map_storage_path FROM public.skud_objects`).
// Цель:      S3-бакет с тем же именем `skud-object-maps` (или
//            $TARGET_BUCKET).
//
// CLI:
//   npm run migrate:yandex:skud-object-maps -- --help
//   npm run migrate:yandex:skud-object-maps -- --dry-run
//   npm run migrate:yandex:skud-object-maps -- --apply
//
// DRY_RUN по умолчанию (env DRY_RUN или флаг). Запись возможна только через
// `--apply` или DRY_RUN=false. Объект НЕ перекладывается, если уже есть в
// target (Head вернул 200) — поведение идемпотентное.

import fs from 'node:fs';
import path from 'node:path';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { Client, type ClientConfig } from 'pg';

const REPORT_DIR = '.migration';
const REPORT_JSON = path.join(REPORT_DIR, 'storage_migration_report.json');
const REPORT_MD = path.join(REPORT_DIR, 'storage_migration_report.md');
const DEFAULT_BATCH = 25;
const SOURCE_BUCKET = 'skud-object-maps';

interface ICliArgs { dryRun: boolean | undefined; help: boolean; }

const HELP_TEXT = `migrate-skud-object-maps-storage — перенос карт объектов СКУД в S3

Usage:
  npm run migrate:yandex:skud-object-maps -- [--dry-run|--apply] [--help]

ENV:
  SOURCE_DATABASE_URL                postgres://...  (required) — Supabase PG
  SOURCE_SUPABASE_URL                https://*.supabase.co  (required)
  SOURCE_SUPABASE_SERVICE_ROLE_KEY   eyJ...  (required)
  SOURCE_SSL                         true|false  default: true
  SOURCE_SSL_CA_PATH                 /path/to/ca.pem  optional

  TARGET_OBJECT_STORAGE_ENDPOINT          https://storage.yandexcloud.net  (required)
  TARGET_OBJECT_STORAGE_REGION            ru-central1  default
  TARGET_OBJECT_STORAGE_ACCESS_KEY_ID     (required)
  TARGET_OBJECT_STORAGE_SECRET_ACCESS_KEY (required)
  TARGET_OBJECT_STORAGE_FORCE_PATH_STYLE  true|false  default: false
  TARGET_BUCKET                            skud-object-maps  default

  DRY_RUN     true|false  default: true (CLI флаги имеют приоритет)
  BATCH_SIZE  integer     default: ${DEFAULT_BATCH}

Поведение:
  1. SELECT id, map_storage_path FROM public.skud_objects
       WHERE map_storage_path IS NOT NULL AND map_storage_path != ''
  2. Для каждой записи:
     - HeadObject target → если уже есть, SKIP (идемпотентно)
     - supabase.storage.from('${SOURCE_BUCKET}').download(path) → Blob
     - PutObject target (с тем же ContentType, если был возвращён)
  3. Отчёт: .migration/storage_migration_report.{json,md}

Exit codes:
  0 — все объекты успешно мигрированы (или SKIP'нуты)
  1 — есть failed
  2 — fatal (ENV/коннект)
`;

function parseArgs(argv: readonly string[]): ICliArgs {
  let dryRun: boolean | undefined;
  let help = false;
  for (const a of argv) {
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--dry-run') {
      if (dryRun === false) throw new Error('Нельзя комбинировать --dry-run и --apply');
      dryRun = true;
    } else if (a === '--apply') {
      if (dryRun === true) throw new Error('Нельзя комбинировать --dry-run и --apply');
      dryRun = false;
    } else {
      throw new Error(`Неизвестный аргумент: ${a}`);
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
  const v = Number.parseInt(raw, 10);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`ENV ${name} должна быть integer в [${min}, ${max}], получено: ${raw}`);
  }
  return v;
}

function buildSourceSsl(): ClientConfig['ssl'] {
  if (!envFlag('SOURCE_SSL', true)) return false;
  const caPath = process.env.SOURCE_SSL_CA_PATH;
  if (caPath) {
    const r = path.resolve(caPath);
    if (!fs.existsSync(r)) throw new Error(`SOURCE_SSL_CA_PATH не найден: ${r}`);
    return { rejectUnauthorized: true, ca: fs.readFileSync(r, 'utf8') };
  }
  return { rejectUnauthorized: true };
}

interface ITargetConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  bucket: string;
}

function resolveTargetConfig(): ITargetConfig {
  const endpoint = process.env.TARGET_OBJECT_STORAGE_ENDPOINT;
  const accessKeyId = process.env.TARGET_OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.TARGET_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint) throw new Error('TARGET_OBJECT_STORAGE_ENDPOINT не задан');
  if (!accessKeyId) throw new Error('TARGET_OBJECT_STORAGE_ACCESS_KEY_ID не задан');
  if (!secretAccessKey) throw new Error('TARGET_OBJECT_STORAGE_SECRET_ACCESS_KEY не задан');
  return {
    endpoint,
    region: process.env.TARGET_OBJECT_STORAGE_REGION || 'ru-central1',
    accessKeyId,
    secretAccessKey,
    forcePathStyle: (process.env.TARGET_OBJECT_STORAGE_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
    bucket: process.env.TARGET_BUCKET || SOURCE_BUCKET,
  };
}

interface IRowOutcome {
  objectId: string;
  storagePath: string;
  status: 'migrated' | 'skipped_exists' | 'skipped_dry_run' | 'failed';
  bytes?: number;
  error?: string;
}

interface IReport {
  startedAt: string;
  finishedAt: string;
  mode: 'dry-run' | 'apply';
  bucket: string;
  totals: {
    fromDb: number;
    migrated: number;
    skippedExists: number;
    skippedDryRun: number;
    failed: number;
  };
  failures: IRowOutcome[];
  sampleSuccess: IRowOutcome[];
}

async function targetHasObject(s3: S3Client, bucket: string, Key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function blobToBuffer(blob: Blob): Promise<{ buffer: Buffer; contentType: string }> {
  const arrayBuffer = await blob.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: blob.type || 'application/octet-stream' };
}

async function run(args: ICliArgs): Promise<number> {
  const dryRun = args.dryRun ?? envFlag('DRY_RUN', true);
  const batchSize = envInt('BATCH_SIZE', DEFAULT_BATCH);

  const sourcePgUrl = process.env.SOURCE_DATABASE_URL;
  const supabaseUrl = process.env.SOURCE_SUPABASE_URL;
  const supabaseKey = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
  if (!sourcePgUrl) throw new Error('SOURCE_DATABASE_URL не задан');
  if (!supabaseUrl) throw new Error('SOURCE_SUPABASE_URL не задан');
  if (!supabaseKey) throw new Error('SOURCE_SUPABASE_SERVICE_ROLE_KEY не задан');

  const tgt = resolveTargetConfig();

  console.log(`mode: ${dryRun ? 'dry-run' : 'APPLY'}`);
  console.log(`source bucket: ${SOURCE_BUCKET}`);
  console.log(`target bucket: ${tgt.bucket} @ ${tgt.endpoint}`);

  const pg = new Client({ connectionString: sourcePgUrl, ssl: buildSourceSsl() });
  await pg.connect();

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const s3 = new S3Client({
    endpoint: tgt.endpoint,
    region: tgt.region,
    forcePathStyle: tgt.forcePathStyle,
    credentials: { accessKeyId: tgt.accessKeyId, secretAccessKey: tgt.secretAccessKey },
  });

  const report: IReport = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    mode: dryRun ? 'dry-run' : 'apply',
    bucket: tgt.bucket,
    totals: { fromDb: 0, migrated: 0, skippedExists: 0, skippedDryRun: 0, failed: 0 },
    failures: [],
    sampleSuccess: [],
  };

  try {
    const { rows } = await pg.query<{ id: string; map_storage_path: string }>(
      `SELECT id::text AS id, map_storage_path
         FROM public.skud_objects
        WHERE map_storage_path IS NOT NULL
          AND length(trim(map_storage_path)) > 0
        ORDER BY map_uploaded_at NULLS LAST, id`,
    );
    report.totals.fromDb = rows.length;
    console.log(`skud_objects с map_storage_path: ${rows.length}`);

    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async row => {
          const storagePath = row.map_storage_path.replace(/^\/+/, '').trim();
          const outcome: IRowOutcome = { objectId: row.id, storagePath, status: 'failed' };
          try {
            // 1. Если уже есть в target — SKIP
            const exists = await targetHasObject(s3, tgt.bucket, storagePath);
            if (exists) {
              outcome.status = 'skipped_exists';
              report.totals.skippedExists++;
              return;
            }

            if (dryRun) {
              outcome.status = 'skipped_dry_run';
              report.totals.skippedDryRun++;
              return;
            }

            // 2. Скачать из Supabase Storage
            const { data: blob, error } = await supabase.storage
              .from(SOURCE_BUCKET)
              .download(storagePath);
            if (error || !blob) {
              outcome.error = `supabase download: ${error?.message || 'no data'}`;
              report.totals.failed++;
              report.failures.push(outcome);
              return;
            }

            const { buffer, contentType } = await blobToBuffer(blob);
            outcome.bytes = buffer.byteLength;

            // 3. PutObject в target
            await s3.send(new PutObjectCommand({
              Bucket: tgt.bucket,
              Key: storagePath,
              Body: buffer,
              ContentType: contentType,
            }));

            outcome.status = 'migrated';
            report.totals.migrated++;
            if (report.sampleSuccess.length < 5) report.sampleSuccess.push(outcome);
          } catch (err) {
            outcome.error = err instanceof Error ? err.message : String(err);
            report.totals.failed++;
            report.failures.push(outcome);
          }
        }),
      );
      console.log(
        `[batch ${i + 1}-${Math.min(i + batchSize, rows.length)}/${rows.length}] ` +
          `migrated=${report.totals.migrated} skipped=${report.totals.skippedExists + report.totals.skippedDryRun} failed=${report.totals.failed}`,
      );
    }
  } finally {
    await pg.end().catch(() => undefined);
  }

  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(REPORT_MD, renderMd(report), 'utf8');

  console.log('\n─── итог ───');
  console.log(`mode: ${report.mode}`);
  console.log(`db rows: ${report.totals.fromDb}`);
  console.log(`migrated=${report.totals.migrated} skipped_exists=${report.totals.skippedExists} skipped_dry_run=${report.totals.skippedDryRun} failed=${report.totals.failed}`);
  console.log(`report: ${REPORT_JSON} / ${REPORT_MD}`);

  return report.totals.failed > 0 ? 1 : 0;
}

function renderMd(r: IReport): string {
  const L: string[] = [];
  L.push('# storage_migration_report (skud-object-maps)');
  L.push('');
  L.push(`- Mode: **${r.mode}**`);
  L.push(`- Started: ${r.startedAt}`);
  L.push(`- Finished: ${r.finishedAt}`);
  L.push(`- Target bucket: \`${r.bucket}\``);
  L.push('');
  L.push('## Totals');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|---|---:|');
  L.push(`| db rows with map_storage_path | ${r.totals.fromDb} |`);
  L.push(`| migrated | ${r.totals.migrated} |`);
  L.push(`| skipped (already exists) | ${r.totals.skippedExists} |`);
  L.push(`| skipped (dry-run) | ${r.totals.skippedDryRun} |`);
  L.push(`| failed | ${r.totals.failed} |`);
  L.push('');
  if (r.failures.length > 0) {
    L.push('## ⚠ Failures');
    L.push('');
    L.push('| object_id | path | error |');
    L.push('|---|---|---|');
    for (const f of r.failures.slice(0, 50)) {
      L.push(`| ${f.objectId} | ${f.storagePath} | ${f.error ?? ''} |`);
    }
    if (r.failures.length > 50) L.push(`\n_... +${r.failures.length - 50} more — см. JSON_`);
    L.push('');
  }
  if (r.sampleSuccess.length > 0) {
    L.push('## Sample successful migrations');
    L.push('');
    L.push('| object_id | path | bytes |');
    L.push('|---|---|---:|');
    for (const s of r.sampleSuccess) {
      L.push(`| ${s.objectId} | ${s.storagePath} | ${s.bytes ?? 0} |`);
    }
    L.push('');
  }
  return L.join('\n') + '\n';
}

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
    const code = await run(args);
    process.exit(code);
  } catch (err) {
    console.error('fatal:', err instanceof Error ? err.stack : err);
    process.exit(2);
  }
}

void main();
