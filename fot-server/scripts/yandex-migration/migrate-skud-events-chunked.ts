// migrate-skud-events-chunked.ts
//
// Chunked миграция public.skud_events из source (Supabase) в target (Yandex PG)
// в обход NLB session timeout перед Supabase pooler. Каждый chunk —
// отдельное короткое подключение SELECT + INSERT, поэтому SSL drop одной
// chunk не валит весь процесс.
//
// Использование:
//   npm run migrate:yandex:skud-events -- --help
//   npm run migrate:yandex:skud-events -- --dry-run --mode=date --days=1
//   npm run migrate:yandex:skud-events -- --apply --mode=date --days=1 --resume
//
// ENV (file .migration/yandex.env):
//   SOURCE_DATABASE_URL          libpq DSN для psql/pg_dump
//   SOURCE_DATABASE_URL_NODE     Node pg DSN (uselibpqcompat=true для Supabase pooler)
//   TARGET_DATABASE_URL          target (Yandex)
//   TARGET_SSL_CA_PATH           для verify-full target
//
// Подробное описание режимов и плана — docs/yandex-postgres-migration/09_skud_events_migration.md

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPORT_DIR = '.migration';
const REPORT_JSON = path.join(REPORT_DIR, 'skud_events_chunks_report.json');
const REPORT_MD = path.join(REPORT_DIR, 'skud_events_chunks_report.md');

const DEFAULT_INSERT_BATCH = 5000;
const DEFAULT_CHUNK_BATCH_SIZE = 50_000;
const DEFAULT_CHUNK_DAYS = 1;
const MAX_RETRIES = 2;

type ChunkMode = 'partition' | 'date' | 'id';

interface ICliArgs {
  dryRun: boolean;
  mode: ChunkMode;
  days: number;
  chunkBatch: number;
  insertBatch: number;
  from: string | null;
  to: string | null;
  resume: boolean;
  help: boolean;
}

interface IChunkResult {
  chunkId: string;
  predicate: string;
  source_count: number | null;
  target_before: number | null;
  inserted: number;
  target_after: number | null;
  duration_ms: number;
  retries: number;
  status: 'ok' | 'skipped_no_rows' | 'skipped_dry_run' | 'failed' | 'skipped_resume';
  error?: string;
}

interface IReport {
  started: string;
  finished: string | null;
  mode: ChunkMode;
  range: { from: string | null; to: string | null };
  options: {
    dryRun: boolean;
    days: number;
    chunkBatch: number;
    insertBatch: number;
  };
  chunks: IChunkResult[];
  totals: {
    source_total: number;
    target_total: number;
    diff: number;
    chunks_ok: number;
    chunks_skipped: number;
    chunks_failed: number;
  };
}

const HELP = `migrate-skud-events-chunked — chunked миграция public.skud_events
из Supabase в Yandex Managed PG.

Usage:
  npm run migrate:yandex:skud-events -- [--dry-run|--apply] [options]

Options (CLI приоритет над ENV):
  --dry-run             только подсчёт chunk'ов и diff, без записи (default).
  --apply               записывать в target.
  --mode=MODE           partition|date|id (default: date).
  --days=N              шаг в днях для mode=date (default: ${DEFAULT_CHUNK_DAYS}).
  --batch=N             шаг по id для mode=id (default: ${DEFAULT_CHUNK_BATCH_SIZE}).
  --insert-batch=N      размер INSERT в target (default: ${DEFAULT_INSERT_BATCH}).
  --from=YYYY-MM-DD     начало диапазона дат (mode=date).
  --to=YYYY-MM-DD       конец диапазона дат включительно.
  --resume              пропускать chunk'и со статусом ok в предыдущем report.
  --help, -h            показать эту справку.

ENV:
  SOURCE_DATABASE_URL_NODE   приоритет (Node pg + uselibpqcompat=true).
  SOURCE_DATABASE_URL        fallback (если NODE-вариант не задан).
  TARGET_DATABASE_URL        обязательно.
  TARGET_SSL_CA_PATH         опционально (sslmode=verify-full).
  DRY_RUN, CHUNK_MODE, CHUNK_DAYS, CHUNK_BATCH_SIZE, BATCH_SIZE — env-аналоги CLI.

Артефакты:
  ${REPORT_JSON}
  ${REPORT_MD}

Exit codes:
  0  все chunks ok / skipped_no_rows / skipped_resume
  1  есть failed chunks
  2  fatal: ENV / коннект / нештатное падение
`;

function parseArgs(argv: readonly string[]): ICliArgs {
  const env = process.env;
  const args: ICliArgs = {
    dryRun: env.DRY_RUN ? env.DRY_RUN !== 'false' : true,
    mode: ((env.CHUNK_MODE as ChunkMode) || 'date'),
    days: env.CHUNK_DAYS ? Math.max(1, Number.parseInt(env.CHUNK_DAYS, 10)) : DEFAULT_CHUNK_DAYS,
    chunkBatch: env.CHUNK_BATCH_SIZE ? Number.parseInt(env.CHUNK_BATCH_SIZE, 10) : DEFAULT_CHUNK_BATCH_SIZE,
    insertBatch: env.BATCH_SIZE ? Number.parseInt(env.BATCH_SIZE, 10) : DEFAULT_INSERT_BATCH,
    from: null,
    to: null,
    resume: false,
    help: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') args.dryRun = false;
    else if (a === '--resume') args.resume = true;
    else if (a.startsWith('--mode=')) {
      const v = a.slice(7);
      if (v !== 'partition' && v !== 'date' && v !== 'id') {
        throw new Error(`--mode должен быть partition|date|id, получено: ${v}`);
      }
      args.mode = v;
    }
    else if (a.startsWith('--days=')) args.days = Math.max(1, Number.parseInt(a.slice(7), 10));
    else if (a.startsWith('--batch=')) args.chunkBatch = Math.max(1, Number.parseInt(a.slice(8), 10));
    else if (a.startsWith('--insert-batch=')) args.insertBatch = Math.max(100, Number.parseInt(a.slice(15), 10));
    else if (a.startsWith('--from=')) args.from = a.slice(7);
    else if (a.startsWith('--to=')) args.to = a.slice(5);
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  if (!Number.isFinite(args.days) || args.days < 1) throw new Error('--days должен быть >= 1');
  if (!Number.isFinite(args.chunkBatch) || args.chunkBatch < 1) throw new Error('--batch должен быть >= 1');
  if (!Number.isFinite(args.insertBatch) || args.insertBatch < 100) throw new Error('--insert-batch должен быть >= 100');
  return args;
}

function loadSourceUrl(): string {
  const url = process.env.SOURCE_DATABASE_URL_NODE || process.env.SOURCE_DATABASE_URL;
  if (!url) {
    console.error('ERROR: SOURCE_DATABASE_URL_NODE или SOURCE_DATABASE_URL должен быть задан');
    process.exit(2);
  }
  return url;
}

function loadTargetUrl(): string {
  const url = process.env.TARGET_DATABASE_URL;
  if (!url) {
    console.error('ERROR: TARGET_DATABASE_URL не задан');
    process.exit(2);
  }
  return url;
}

function ensureReportDir(): void {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function loadPreviousReport(): IReport | null {
  if (!fs.existsSync(REPORT_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(REPORT_JSON, 'utf8')) as IReport;
  } catch {
    return null;
  }
}

interface IChunkSpec {
  chunkId: string;
  predicate: string;
  params: unknown[];
}

async function discoverChunksByDate(client: Client, from: string | null, to: string | null, days: number): Promise<IChunkSpec[]> {
  const range = await client.query<{ min_d: string | null; max_d: string | null }>(
    `SELECT
       COALESCE(${from ? '$1::date' : 'NULL'}, MIN(event_date))::text AS min_d,
       COALESCE(${to ? (from ? '$2' : '$1') + '::date' : 'NULL'}, MAX(event_date))::text AS max_d
     FROM public.skud_events`,
    [from, to].filter(Boolean) as string[],
  );
  const min = range.rows[0]?.min_d;
  const max = range.rows[0]?.max_d;
  if (!min || !max) return [];

  const chunks: IChunkSpec[] = [];
  let cur = new Date(`${min}T00:00:00Z`);
  const end = new Date(`${max}T00:00:00Z`);
  while (cur <= end) {
    const startStr = cur.toISOString().slice(0, 10);
    const next = new Date(cur);
    next.setUTCDate(next.getUTCDate() + days);
    const stopStr = (next > end ? end : new Date(next.getTime() - 86_400_000)).toISOString().slice(0, 10);
    chunks.push({
      chunkId: days === 1 ? startStr : `${startStr}..${stopStr}`,
      predicate: 'event_date >= $1::date AND event_date <= $2::date',
      params: [startStr, stopStr],
    });
    cur = next;
  }
  return chunks;
}

async function discoverChunksByPartition(client: Client): Promise<IChunkSpec[]> {
  const rows = await client.query<{ rel: string }>(
    `SELECT inhrelid::regclass::text AS rel
       FROM pg_inherits
      WHERE inhparent = 'public.skud_events'::regclass
      ORDER BY rel`,
  );
  return rows.rows.map(r => ({
    chunkId: r.rel,
    predicate: `tableoid::regclass::text = $1`,
    params: [r.rel],
  }));
}

async function discoverChunksById(client: Client, chunkBatch: number): Promise<IChunkSpec[]> {
  const r = await client.query<{ min_id: string | null; max_id: string | null }>(
    `SELECT MIN(id)::text AS min_id, MAX(id)::text AS max_id FROM public.skud_events`,
  );
  const min = r.rows[0]?.min_id ? Number(r.rows[0].min_id) : null;
  const max = r.rows[0]?.max_id ? Number(r.rows[0].max_id) : null;
  if (min === null || max === null) return [];
  const chunks: IChunkSpec[] = [];
  for (let lo = min; lo <= max; lo += chunkBatch) {
    const hi = Math.min(lo + chunkBatch - 1, max);
    chunks.push({
      chunkId: `id:${lo}..${hi}`,
      predicate: 'id >= $1::bigint AND id <= $2::bigint',
      params: [lo, hi],
    });
  }
  return chunks;
}

async function countChunk(client: Client, predicate: string, params: unknown[]): Promise<number> {
  const r = await client.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM public.skud_events WHERE ${predicate}`,
    params,
  );
  return Number(r.rows[0]?.c ?? '0');
}

const EVENT_COLUMNS = [
  'id', 'event_date', 'event_time', 'event_at', 'access_point', 'direction',
  'employee_id', 'created_at', 'dedup_hash', 'physical_person', 'card_number',
] as const;

async function migrateChunk(
  source: Client,
  target: Client,
  predicate: string,
  params: unknown[],
  insertBatch: number,
): Promise<number> {
  // SELECT в кусочках по LIMIT/OFFSET через id-cursor для стабильной пагинации.
  // OFFSET был бы O(n) на большие чанки, используем seek-pagination по id.
  let lastId = -1n;
  let totalInserted = 0;
  // Полный список колонок (без OFFSET); seek по id.
  const cols = EVENT_COLUMNS.join(', ');
  while (true) {
    const sel = await source.query<Record<string, unknown>>(
      `SELECT ${cols}
         FROM public.skud_events
        WHERE ${predicate} AND id > $${params.length + 1}::bigint
        ORDER BY id ASC
        LIMIT ${insertBatch}`,
      [...params, lastId.toString()],
    );
    if (sel.rows.length === 0) break;

    // Bulk INSERT через unnest. ON CONFLICT (dedup_hash, event_date) DO NOTHING.
    const placeholders: string[] = [];
    const insParams: unknown[] = [];
    for (const row of sel.rows) {
      const group: string[] = [];
      for (const col of EVENT_COLUMNS) {
        insParams.push(row[col]);
        group.push(`$${insParams.length}`);
      }
      placeholders.push(`(${group.join(', ')})`);
    }
    await target.query(
      `INSERT INTO public.skud_events (${cols})
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (dedup_hash, event_date) DO NOTHING`,
      insParams,
    );
    totalInserted += sel.rows.length;
    lastId = BigInt(String(sel.rows[sel.rows.length - 1].id));
    if (sel.rows.length < insertBatch) break;
  }
  return totalInserted;
}

function buildClient(url: string, caPath: string | undefined): Client {
  const opts: ConstructorParameters<typeof Client>[0] = { connectionString: url };
  if (caPath && fs.existsSync(caPath)) {
    opts.ssl = { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  return new Client(opts);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const sourceUrl = loadSourceUrl();
  const targetUrl = loadTargetUrl();
  const sourceCaPath = process.env.SOURCE_SSL_CA_PATH;
  const targetCaPath = process.env.TARGET_SSL_CA_PATH;

  ensureReportDir();
  const previousReport = args.resume ? loadPreviousReport() : null;
  const okChunkIds = new Set(
    (previousReport?.chunks ?? []).filter(c => c.status === 'ok').map(c => c.chunkId),
  );

  console.log('mode:', args.dryRun ? 'dry-run' : 'APPLY');
  console.log('chunk mode:', args.mode);
  if (args.mode === 'date') console.log(`  days: ${args.days}`);
  if (args.mode === 'id') console.log(`  batch: ${args.chunkBatch}`);
  console.log(`insert batch: ${args.insertBatch}`);
  if (okChunkIds.size > 0) console.log(`resume: пропустим ${okChunkIds.size} ok-chunks из предыдущего report`);

  const source = buildClient(sourceUrl, sourceCaPath);
  const target = buildClient(targetUrl, targetCaPath);
  await source.connect();
  await target.connect();

  let chunks: IChunkSpec[];
  try {
    if (args.mode === 'partition') chunks = await discoverChunksByPartition(source);
    else if (args.mode === 'id') chunks = await discoverChunksById(source, args.chunkBatch);
    else chunks = await discoverChunksByDate(source, args.from, args.to, args.days);
  } catch (err) {
    console.error('ERROR: discover chunks:', (err as Error).message);
    await source.end().catch(() => undefined);
    await target.end().catch(() => undefined);
    process.exit(2);
  }

  console.log(`discovered chunks: ${chunks.length}`);

  const report: IReport = {
    started: new Date().toISOString(),
    finished: null,
    mode: args.mode,
    range: { from: args.from, to: args.to },
    options: {
      dryRun: args.dryRun,
      days: args.days,
      chunkBatch: args.chunkBatch,
      insertBatch: args.insertBatch,
    },
    chunks: [],
    totals: { source_total: 0, target_total: 0, diff: 0, chunks_ok: 0, chunks_skipped: 0, chunks_failed: 0 },
  };

  for (const c of chunks) {
    const t0 = Date.now();
    if (okChunkIds.has(c.chunkId)) {
      report.chunks.push({
        chunkId: c.chunkId, predicate: c.predicate, source_count: null, target_before: null,
        inserted: 0, target_after: null, duration_ms: Date.now() - t0, retries: 0,
        status: 'skipped_resume',
      });
      report.totals.chunks_skipped++;
      console.log(`[${c.chunkId}] skip (resume)`);
      continue;
    }

    let retries = 0;
    let result: IChunkResult | null = null;
    while (retries <= MAX_RETRIES) {
      try {
        const source_count = await countChunk(source, c.predicate, c.params);
        const target_before = await countChunk(target, c.predicate, c.params);
        report.totals.source_total += source_count;

        if (source_count === 0) {
          result = {
            chunkId: c.chunkId, predicate: c.predicate, source_count, target_before,
            inserted: 0, target_after: target_before, duration_ms: Date.now() - t0, retries,
            status: 'skipped_no_rows',
          };
          break;
        }
        if (args.dryRun) {
          result = {
            chunkId: c.chunkId, predicate: c.predicate, source_count, target_before,
            inserted: 0, target_after: target_before, duration_ms: Date.now() - t0, retries,
            status: 'skipped_dry_run',
          };
          break;
        }

        const inserted = await migrateChunk(source, target, c.predicate, c.params, args.insertBatch);
        const target_after = await countChunk(target, c.predicate, c.params);
        result = {
          chunkId: c.chunkId, predicate: c.predicate, source_count, target_before,
          inserted, target_after, duration_ms: Date.now() - t0, retries, status: 'ok',
        };
        break;
      } catch (err) {
        retries++;
        const msg = err instanceof Error ? err.message : String(err);
        if (retries > MAX_RETRIES) {
          result = {
            chunkId: c.chunkId, predicate: c.predicate, source_count: null, target_before: null,
            inserted: 0, target_after: null, duration_ms: Date.now() - t0, retries: retries - 1,
            status: 'failed', error: msg,
          };
        } else {
          console.warn(`[${c.chunkId}] retry ${retries}/${MAX_RETRIES}: ${msg}`);
          await new Promise(r => setTimeout(r, 2000 * retries));
        }
      }
    }
    if (!result) throw new Error('internal: result not set');
    report.chunks.push(result);
    if (result.status === 'ok') {
      report.totals.chunks_ok++;
      report.totals.target_total += (result.target_after ?? 0);
    } else if (result.status === 'failed') {
      report.totals.chunks_failed++;
    } else {
      report.totals.chunks_skipped++;
    }
    console.log(
      `[${c.chunkId}] ${result.status} src=${result.source_count ?? '-'}`
      + ` tgt_before=${result.target_before ?? '-'} inserted=${result.inserted}`
      + ` tgt_after=${result.target_after ?? '-'} (${result.duration_ms}ms)`
      + (result.error ? ` ERROR: ${result.error}` : ''),
    );
  }

  report.finished = new Date().toISOString();
  report.totals.diff = report.totals.target_total - report.totals.source_total;
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(REPORT_MD, buildMarkdown(report), 'utf8');

  console.log('');
  console.log(`─── итог ───`);
  console.log(`chunks total: ${chunks.length}`);
  console.log(`ok=${report.totals.chunks_ok}  skipped=${report.totals.chunks_skipped}  failed=${report.totals.chunks_failed}`);
  console.log(`source total: ${report.totals.source_total}`);
  console.log(`target total: ${report.totals.target_total}`);
  console.log(`diff: ${report.totals.diff}`);
  console.log(`report: ${REPORT_JSON} / ${REPORT_MD}`);

  await source.end().catch(() => undefined);
  await target.end().catch(() => undefined);

  process.exit(report.totals.chunks_failed > 0 ? 1 : 0);
}

function buildMarkdown(r: IReport): string {
  const lines: string[] = [];
  lines.push(`# skud_events_chunks_report\n`);
  lines.push(`- Mode: **${r.options.dryRun ? 'dry-run' : 'apply'}**`);
  lines.push(`- Chunk mode: \`${r.mode}\``);
  lines.push(`- Started: ${r.started}`);
  lines.push(`- Finished: ${r.finished ?? '-'}\n`);
  lines.push(`## Totals\n`);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| chunks | ${r.chunks.length} |`);
  lines.push(`| chunks ok | ${r.totals.chunks_ok} |`);
  lines.push(`| chunks skipped | ${r.totals.chunks_skipped} |`);
  lines.push(`| chunks failed | ${r.totals.chunks_failed} |`);
  lines.push(`| source total | ${r.totals.source_total} |`);
  lines.push(`| target total | ${r.totals.target_total} |`);
  lines.push(`| diff | ${r.totals.diff} |\n`);
  lines.push(`## Chunks\n`);
  lines.push(`| chunk_id | status | source | target_before | inserted | target_after | duration | retries | error |`);
  lines.push(`|---|---|---:|---:|---:|---:|---:|---:|---|`);
  for (const c of r.chunks) {
    lines.push(`| \`${c.chunkId}\` | ${c.status} | ${c.source_count ?? '-'} | ${c.target_before ?? '-'} | ${c.inserted} | ${c.target_after ?? '-'} | ${c.duration_ms}ms | ${c.retries} | ${(c.error ?? '').replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n') + '\n';
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
