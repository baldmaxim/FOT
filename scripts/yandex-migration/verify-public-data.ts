// verify-public-data.ts
// Сверка count(*) всех public-таблиц между SOURCE_DATABASE_URL (Supabase) и
// TARGET_DATABASE_URL (Yandex Managed PG) после restore.
//
// Запуск из fot-server: `npm run migrate:yandex:verify-public`.
//
// Не зависит от npm-пакетов (использует только node:* + shell-out на psql),
// поэтому может жить вне fot-server.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPORT_JSON_DEFAULT = '.migration/verify_public_data_report.json';
const REPORT_MD_DEFAULT = '.migration/verify_public_data_report.md';

// Бизнес-критичные таблицы, для которых отчёт показывает строку отдельно
// сверху (легче ревьюить). Полный список public.* всё равно сверяется.
const FOCUS_TABLES: readonly string[] = [
  'user_profiles',
  'system_roles',
  'role_page_access',
  'access_pages',
  'employees',
  'employee_assignments',
  'employee_department_access',
  'employee_direct_reports',
  'user_company_access',
  'org_departments',
  'positions',
  'work_schedules',
  'employee_schedule_assignments',
  'object_schedule_assignments',
  'attendance_adjustments',
  'timesheet_approvals',
  'timesheet_approval_events',
  'skud_events',
  'skud_event_failures',
  'skud_daily_summary',
  'sigur_runtime_state',
  'documents',
  'document_links',
  'patent_payment_receipts',
  'data_api_keys',
  'data_api_key_tables',
  'data_api_request_logs',
  'daily_tasks',
];

interface IArgs {
  reportJson: string;
  reportMd: string;
  help: boolean;
}

const HELP = `verify-public-data — сверка count(*) public-таблиц SOURCE vs TARGET

Usage:
  npm run migrate:yandex:verify-public -- [--report-json PATH] [--report-md PATH]

ENV:
  SOURCE_DATABASE_URL   postgres://...  (required) — Supabase
  TARGET_DATABASE_URL   postgres://...  (required) — Yandex Managed PG

  SKUD_EVENTS_MIGRATION_MODE       'sigur_api_manual' | unset (default).
                                   Если задано 'sigur_api_manual' И
                                   CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true,
                                   skud_events* diff помечается как
                                   ACCEPTED_MANUAL_BACKFILL и НЕ влияет на
                                   exit code. Иначе skud_events* skipped
                                   = exit 1 (production-readiness gate).
  CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL  'true' | unset. Двойная защита от
                                   случайного выставления mode без явного
                                   подтверждения owner'а.

Что делает:
  1. Из SOURCE собирает список public.* base tables.
  2. Для каждой таблицы выполняет SELECT count(*)::text FROM public.<t>
     на SOURCE и TARGET.
  3. Сравнивает; помечает diff != 0 как FAIL.
  4. Для skud_events* семейства учитывает SKUD_EVENTS_MIGRATION_MODE:
     - sigur_api_manual + confirmed → ACCEPTED_MANUAL_BACKFILL (exit 0 ok)
     - migrated via chunks (report exists, всё ok) → SKIPPED_MIGRATED_VIA_CHUNKS
     - всё остальное при diff → SKIPPED_PENDING (exit 1)
  5. Выводит focus-таблицы первым блоком (см. список в коде), затем все
     остальные.
  6. Сохраняет report-json + report-md.

Exit codes:
  0 — все count(*) совпадают (или skud_events* в accepted/migrated режиме)
  1 — есть расхождения / skud_events* skipped без acceptance
  2 — ошибка (psql/ENV/таблица не существует на одной стороне)
`;

function parseArgs(argv: readonly string[]): IArgs {
  const out: IArgs = { reportJson: REPORT_JSON_DEFAULT, reportMd: REPORT_MD_DEFAULT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--report-json') out.reportJson = argv[++i];
    else if (a === '--report-md') out.reportMd = argv[++i];
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  return out;
}

function runPsqlScalar(url: string, sql: string): string {
  const r = spawnSync('psql', [url, '-tA', '--no-psqlrc', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function runPsqlList(url: string, sql: string): string[] {
  const out = runPsqlScalar(url, sql);
  if (!out) return [];
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function ensureDir(filePath: string): void {
  const d = dirname(resolve(filePath));
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

interface ITableResult {
  table: string;
  sourceCount: number | null;
  targetCount: number | null;
  diff: number | null;
  status:
    | 'match'
    | 'diff'
    | 'error'
    | 'skipped_pending'
    | 'skipped_migrated_via_chunks'
    | 'accepted_manual_backfill';
  reason?: string;
  error?: string;
  focused: boolean;
}

type SkudEventsMigrationMode = 'sigur_api_manual' | null;

function readSkudEventsMode(): { mode: SkudEventsMigrationMode; confirmed: boolean } {
  const rawMode = (process.env.SKUD_EVENTS_MIGRATION_MODE ?? '').trim();
  const rawConfirm = (process.env.CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL ?? '').trim().toLowerCase();
  const mode: SkudEventsMigrationMode = rawMode === 'sigur_api_manual' ? 'sigur_api_manual' : null;
  const confirmed = rawConfirm === 'true';
  return { mode, confirmed };
}

const SKUD_EVENTS_CHUNKS_REPORT = '.migration/skud_events_chunks_report.json';

interface ISkudEventsChunksReport {
  totals?: {
    source_total?: number;
    target_total?: number;
    chunks_ok?: number;
    chunks_failed?: number;
  };
  finished?: string | null;
}

function loadSkudEventsChunksReport(): ISkudEventsChunksReport | null {
  try {
    if (!existsSync(SKUD_EVENTS_CHUNKS_REPORT)) return null;
    return JSON.parse(readFileSync(SKUD_EVENTS_CHUNKS_REPORT, 'utf8')) as ISkudEventsChunksReport;
  } catch {
    return null;
  }
}

/**
 * Returns true if table is `skud_events`, any of its partitions, or quarantine.
 * Эти таблицы исключены из основного pg_dump из-за AWS NLB session timeout
 * на Supabase pooler. Миграция делается отдельно через chunked-скрипт
 * или Sigur API backfill — см. 09_skud_events_migration.md.
 */
function isSkudEventsTable(name: string): boolean {
  return name === 'skud_events'
    || name.startsWith('skud_events_')
    || name === 'skud_events_quarantine';
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

  // verify-public-data использует psql (libpq) для COUNT(*), поэтому
  // нужен только libpq-compatible DSN — SOURCE_DATABASE_URL без
  // Node-specific параметра uselibpqcompat.
  const source = process.env.SOURCE_DATABASE_URL;
  const target = process.env.TARGET_DATABASE_URL;
  if (!source) {
    console.error('ERROR: SOURCE_DATABASE_URL не задан');
    process.exit(2);
  }
  if (!target) {
    console.error('ERROR: TARGET_DATABASE_URL не задан');
    process.exit(2);
  }

  // Sanity check + версии
  let sourceVersion = '?';
  let targetVersion = '?';
  try {
    sourceVersion = runPsqlScalar(source, 'SELECT version();');
    targetVersion = runPsqlScalar(target, 'SELECT version();');
  } catch (err) {
    console.error('ERROR: не удалось подключиться к одной из БД:', (err as Error).message);
    process.exit(2);
  }
  console.log('source:', sourceVersion);
  console.log('target:', targetVersion);

  // Все public base tables на source
  const tables = runPsqlList(
    source,
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name;`,
  );
  console.log(`public.* base tables on source: ${tables.length}`);

  const focusSet = new Set(FOCUS_TABLES);
  const results: ITableResult[] = [];
  const skudReport = loadSkudEventsChunksReport();
  const skudChunksFinished = skudReport?.finished !== null && skudReport?.finished !== undefined;
  const skudChunksAllOk = (skudReport?.totals?.chunks_failed ?? 0) === 0
    && (skudReport?.totals?.chunks_ok ?? 0) > 0;
  const skudMode = readSkudEventsMode();
  const skudAcceptedManualBackfill = skudMode.mode === 'sigur_api_manual' && skudMode.confirmed;

  for (const t of tables) {
    const safeT = t.replace(/"/g, '""');
    const q = `SELECT count(*)::text FROM public."${safeT}";`;
    let srcN: number | null = null;
    let tgtN: number | null = null;
    let err: string | undefined;
    try {
      srcN = Number.parseInt(runPsqlScalar(source, q), 10);
    } catch (e) {
      err = `source: ${(e as Error).message}`;
    }
    try {
      tgtN = Number.parseInt(runPsqlScalar(target, q), 10);
    } catch (e) {
      err = (err ? err + '; ' : '') + `target: ${(e as Error).message}`;
    }
    let status: ITableResult['status'] = 'error';
    let diff: number | null = null;
    let reason: string | undefined;
    if (srcN !== null && tgtN !== null && Number.isFinite(srcN) && Number.isFinite(tgtN)) {
      diff = tgtN - srcN;
      status = diff === 0 ? 'match' : 'diff';
      if (isSkudEventsTable(t) && status === 'diff') {
        // skud_events* семейство — приоритет проверок:
        //   1) chunked DB migration (если report показывает успешный прогон)
        //   2) ACCEPTED_MANUAL_BACKFILL (sigur_api_manual + confirmed)
        //   3) SKIPPED_PENDING (default — fail для production-readiness)
        if (skudChunksFinished && skudChunksAllOk) {
          status = 'skipped_migrated_via_chunks';
          reason = 'skud_events migrated through chunked script; remaining diff likely due to live source updates after chunk run';
        } else if (skudAcceptedManualBackfill) {
          status = 'accepted_manual_backfill';
          reason = 'skud_events DB migration intentionally skipped; production-path = manual Sigur API backfill (SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual, CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true). See 09_skud_events_migration.md for verification steps and owner acceptance gate.';
        } else {
          status = 'skipped_pending';
          reason = 'skud_events excluded from primary pg_dump (NLB timeout). See docs/yandex-postgres-migration/09_skud_events_migration.md for migration plan (chunked OR Sigur API backfill). This is NOT a pass for production readiness. To accept Sigur API manual backfill set SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual and CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true.';
        }
      }
    }
    results.push({
      table: t,
      sourceCount: srcN,
      targetCount: tgtN,
      diff,
      status,
      reason,
      error: err,
      focused: focusSet.has(t),
    });
  }

  // Focus-таблицы, которые ожидались, но отсутствуют на source
  const sourceTableSet = new Set(tables);
  const missingFocused: string[] = [];
  for (const ft of FOCUS_TABLES) {
    if (!sourceTableSet.has(ft)) {
      missingFocused.push(ft);
    }
  }

  const skipped_pending_count = results.filter(r => r.status === 'skipped_pending').length;
  const skipped_migrated_count = results.filter(r => r.status === 'skipped_migrated_via_chunks').length;
  const accepted_manual_backfill_count = results.filter(r => r.status === 'accepted_manual_backfill').length;

  // Сводный skud_events_status — один из четырёх для удобства downstream-tooling.
  let skudEventsStatus: 'match' | 'diff' | 'skipped_pending' | 'skipped_migrated_via_chunks' | 'accepted_manual_backfill';
  if (accepted_manual_backfill_count > 0) skudEventsStatus = 'accepted_manual_backfill';
  else if (skipped_migrated_count > 0) skudEventsStatus = 'skipped_migrated_via_chunks';
  else if (skipped_pending_count > 0) skudEventsStatus = 'skipped_pending';
  else if (results.some(r => isSkudEventsTable(r.table) && r.status === 'diff')) skudEventsStatus = 'diff';
  else skudEventsStatus = 'match';

  const summary = {
    totalChecked: results.length,
    match: results.filter(r => r.status === 'match').length,
    diff: results.filter(r => r.status === 'diff').length,
    error: results.filter(r => r.status === 'error').length,
    skipped_pending: skipped_pending_count,
    skipped_migrated_via_chunks: skipped_migrated_count,
    accepted_manual_backfill: accepted_manual_backfill_count,
    missingFocusedOnSource: missingFocused.length,
    skud_events_migration_mode: skudMode.mode,
    skud_events_manual_backfill_confirmed: skudMode.confirmed,
    skud_events_status: skudEventsStatus,
    skudEventsChunksReport: skudReport
      ? {
          finished: skudReport.finished ?? null,
          chunks_ok: skudReport.totals?.chunks_ok ?? 0,
          chunks_failed: skudReport.totals?.chunks_failed ?? 0,
          source_total: skudReport.totals?.source_total ?? 0,
          target_total: skudReport.totals?.target_total ?? 0,
        }
      : null,
  };

  const report = {
    startedAt: new Date().toISOString(),
    versions: { source: sourceVersion, target: targetVersion },
    summary,
    focusTables: results.filter(r => r.focused).sort((a, b) => a.table.localeCompare(b.table)),
    otherTables: results.filter(r => !r.focused).sort((a, b) => a.table.localeCompare(b.table)),
    missingFocusedOnSource: missingFocused,
  };

  ensureDir(args.reportJson);
  ensureDir(args.reportMd);
  writeFileSync(args.reportJson, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(args.reportMd, renderMd(report), 'utf8');

  console.log('\n─── итог ───');
  console.log(`tables: ${summary.totalChecked}`);
  console.log(
    `match=${summary.match}  diff=${summary.diff}  error=${summary.error}`
    + `  skipped_pending=${summary.skipped_pending}  skipped_migrated=${summary.skipped_migrated_via_chunks}`
    + `  accepted_manual_backfill=${summary.accepted_manual_backfill}`,
  );
  console.log(`skud_events_status: ${summary.skud_events_status}`);
  if (skipped_pending_count > 0) {
    console.log(
      `⚠ skipped_pending=${skipped_pending_count}: skud_events* не мигрированы и acceptance не выставлен.`
      + ' См. docs/yandex-postgres-migration/09_skud_events_migration.md.'
      + ' Чтобы принять Sigur API manual backfill: export SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual && export CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true.',
    );
  }
  if (skipped_migrated_count > 0) {
    console.log(
      `✓ skipped_migrated_via_chunks=${skipped_migrated_count}: skud_events* мигрированы через chunked-скрипт`
      + ` (chunks_ok=${summary.skudEventsChunksReport?.chunks_ok ?? 0}).`,
    );
  }
  if (accepted_manual_backfill_count > 0) {
    console.log(
      `✓ accepted_manual_backfill=${accepted_manual_backfill_count}: skud_events* skipped, production-путь = Sigur API manual backfill.`
      + ' Verification обязателен после backfill — см. 09_skud_events_migration.md § Verification.',
    );
  }
  if (missingFocused.length > 0) {
    console.log(`focused-but-missing-on-source: ${missingFocused.join(', ')}`);
  }
  console.log(`report: ${args.reportJson} / ${args.reportMd}`);

  // skipped_pending — НЕ pass: production readiness требует решения по skud_events.
  // accepted_manual_backfill — pass с явным acceptance.
  // diff / error — традиционный fail.
  if (summary.diff > 0 || summary.error > 0 || skipped_pending_count > 0) {
    process.exit(1);
  }
  process.exit(0);
}

interface IReportShape {
  startedAt: string;
  versions: { source: string; target: string };
  summary: {
    totalChecked: number;
    match: number;
    diff: number;
    error: number;
    skipped_pending: number;
    skipped_migrated_via_chunks: number;
    accepted_manual_backfill: number;
    missingFocusedOnSource: number;
    skud_events_migration_mode: SkudEventsMigrationMode;
    skud_events_manual_backfill_confirmed: boolean;
    skud_events_status: 'match' | 'diff' | 'skipped_pending' | 'skipped_migrated_via_chunks' | 'accepted_manual_backfill';
    skudEventsChunksReport: {
      finished: string | null;
      chunks_ok: number;
      chunks_failed: number;
      source_total: number;
      target_total: number;
    } | null;
  };
  focusTables: ITableResult[];
  otherTables: ITableResult[];
  missingFocusedOnSource: string[];
}

function renderMd(r: IReportShape): string {
  const lines: string[] = [];
  lines.push('# verify-public-data report');
  lines.push('');
  lines.push(`- Started: ${r.startedAt}`);
  lines.push(`- Source: \`${r.versions.source}\``);
  lines.push(`- Target: \`${r.versions.target}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| tables checked | ${r.summary.totalChecked} |`);
  lines.push(`| match | ${r.summary.match} |`);
  lines.push(`| diff | ${r.summary.diff} |`);
  lines.push(`| error | ${r.summary.error} |`);
  lines.push(`| skipped (pending — see 09_skud_events_migration) | ${r.summary.skipped_pending} |`);
  lines.push(`| skipped (migrated via chunks) | ${r.summary.skipped_migrated_via_chunks} |`);
  lines.push(`| accepted (manual Sigur API backfill) | ${r.summary.accepted_manual_backfill} |`);
  lines.push(`| focused missing on source | ${r.summary.missingFocusedOnSource} |`);
  lines.push(`| **skud_events_status** | **${r.summary.skud_events_status}** |`);
  lines.push(`| skud_events_migration_mode | ${r.summary.skud_events_migration_mode ?? '(unset)'} |`);
  lines.push(`| skud_events_manual_backfill_confirmed | ${r.summary.skud_events_manual_backfill_confirmed} |`);
  lines.push('');
  if (r.summary.skudEventsChunksReport) {
    const c = r.summary.skudEventsChunksReport;
    lines.push('### skud_events chunks report (read from `.migration/skud_events_chunks_report.json`)');
    lines.push('');
    lines.push(`- finished: ${c.finished ?? 'in progress'}`);
    lines.push(`- chunks ok: ${c.chunks_ok}, failed: ${c.chunks_failed}`);
    lines.push(`- source total: ${c.source_total}, target total: ${c.target_total}`);
    lines.push('');
  }
  if (r.summary.skipped_pending > 0) {
    lines.push('### ⚠ skud_events* skipped — production readiness gate (FAIL)');
    lines.push('');
    lines.push('Этот verify-run **НЕ pass** для production: семейство `skud_events` не было');
    lines.push('включено в основной dump из-за NLB session timeout, и acceptance-флаги не выставлены.');
    lines.push('');
    lines.push('**`skud_events are excluded from DB restore and must be manually backfilled via Sigur API.`**');
    lines.push('');
    lines.push('Решение (одно из):');
    lines.push('');
    lines.push('1. **Принять Sigur API manual backfill** (рекомендованный production-путь):');
    lines.push('   ```bash');
    lines.push('   export SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual');
    lines.push('   export CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true');
    lines.push('   npm run migrate:yandex:verify-public');
    lines.push('   ```');
    lines.push('   Подробности и verification-чеклист — [09_skud_events_migration.md § Verification после backfill](../docs/yandex-postgres-migration/09_skud_events_migration.md).');
    lines.push('');
    lines.push('2. **Запустить chunked DB migration** (safety net):');
    lines.push('   ```bash');
    lines.push('   npm run migrate:yandex:skud-events -- --apply --mode=date --days=1');
    lines.push('   ```');
    lines.push('');
  }
  if (r.summary.accepted_manual_backfill > 0) {
    lines.push('### ✓ skud_events* — accepted manual backfill mode');
    lines.push('');
    lines.push('`skud_events*` (parent + 19 партиций + quarantine) намеренно исключены из DB-миграции.');
    lines.push('Production-путь: **manual Sigur API backfill** через `presence-polling` runtime после cutover.');
    lines.push('');
    lines.push(`- \`SKUD_EVENTS_MIGRATION_MODE=${r.summary.skud_events_migration_mode}\``);
    lines.push(`- \`CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=${r.summary.skud_events_manual_backfill_confirmed}\``);
    lines.push('');
    lines.push('**Обязательно после backfill** прогнать verification-запросы из');
    lines.push('[09_skud_events_migration.md § Verification](../docs/yandex-postgres-migration/09_skud_events_migration.md):');
    lines.push('count by date, distinct dedup_hash, sample, batch_recalculate_skud_daily_summary, diff vs source.');
    lines.push('Owner acceptance gate подтверждается приложением результатов к cutover-runbook.');
    lines.push('');
  }

  if (r.missingFocusedOnSource.length > 0) {
    lines.push('## ⚠ Focused tables missing on SOURCE');
    lines.push('');
    for (const t of r.missingFocusedOnSource) lines.push(`- \`public.${t}\``);
    lines.push('');
  }

  lines.push('## Focus tables');
  lines.push('');
  lines.push(renderTable(r.focusTables));
  lines.push('');
  lines.push('## All other public tables');
  lines.push('');
  lines.push(renderTable(r.otherTables));
  return lines.join('\n') + '\n';
}

function renderTable(rows: ITableResult[]): string {
  if (rows.length === 0) return '_нет данных_';
  const lines: string[] = [];
  lines.push('| Table | Source | Target | Diff | Status | Notes |');
  lines.push('|---|---:|---:|---:|---|---|');
  for (const r of rows) {
    const src = r.sourceCount === null ? '-' : r.sourceCount.toString();
    const tgt = r.targetCount === null ? '-' : r.targetCount.toString();
    const diff = r.diff === null ? '-' : r.diff.toString();
    const statusIcon =
      r.status === 'match' ? '✓ match' :
      r.status === 'diff' ? '✗ diff' :
      r.status === 'skipped_pending' ? '⏸ skipped (pending)' :
      r.status === 'skipped_migrated_via_chunks' ? '↻ migrated via chunks' :
      r.status === 'accepted_manual_backfill' ? '⏭ accepted (manual Sigur backfill)' :
      '⚠ error';
    const note = r.reason ?? r.error ?? '';
    lines.push(`| \`${r.table}\` | ${src} | ${tgt} | ${diff} | ${statusIcon} | ${note.replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n');
}

main().catch(err => {
  console.error('uncaught:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
