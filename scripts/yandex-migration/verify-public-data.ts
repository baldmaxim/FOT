// verify-public-data.ts
// Сверка count(*) всех public-таблиц между SOURCE_DATABASE_URL (Supabase) и
// TARGET_DATABASE_URL (Yandex Managed PG) после restore.
//
// Запуск из fot-server: `npm run migrate:yandex:verify-public`.
//
// Не зависит от npm-пакетов (использует только node:* + shell-out на psql),
// поэтому может жить вне fot-server.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

Что делает:
  1. Из SOURCE собирает список public.* base tables.
  2. Для каждой таблицы выполняет SELECT count(*)::text FROM public.<t>
     на SOURCE и TARGET.
  3. Сравнивает; помечает diff != 0 как FAIL.
  4. Выводит focus-таблицы первым блоком (см. список в коде), затем все
     остальные.
  5. Сохраняет report-json + report-md.

Exit codes:
  0 — все count(*) совпадают
  1 — есть расхождения (см. отчёт)
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
  status: 'match' | 'diff' | 'error';
  error?: string;
  focused: boolean;
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
    if (srcN !== null && tgtN !== null && Number.isFinite(srcN) && Number.isFinite(tgtN)) {
      diff = tgtN - srcN;
      status = diff === 0 ? 'match' : 'diff';
    }
    results.push({
      table: t,
      sourceCount: srcN,
      targetCount: tgtN,
      diff,
      status,
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

  const summary = {
    totalChecked: results.length,
    match: results.filter(r => r.status === 'match').length,
    diff: results.filter(r => r.status === 'diff').length,
    error: results.filter(r => r.status === 'error').length,
    missingFocusedOnSource: missingFocused.length,
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
  console.log(`match=${summary.match}  diff=${summary.diff}  error=${summary.error}`);
  if (missingFocused.length > 0) {
    console.log(`focused-but-missing-on-source: ${missingFocused.join(', ')}`);
  }
  console.log(`report: ${args.reportJson} / ${args.reportMd}`);

  if (summary.diff > 0 || summary.error > 0) {
    process.exit(1);
  }
  process.exit(0);
}

interface IReportShape {
  startedAt: string;
  versions: { source: string; target: string };
  summary: { totalChecked: number; match: number; diff: number; error: number; missingFocusedOnSource: number };
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
  lines.push(`| focused missing on source | ${r.summary.missingFocusedOnSource} |`);
  lines.push('');

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
  lines.push('| Table | Source | Target | Diff | Status | Error |');
  lines.push('|---|---:|---:|---:|---|---|');
  for (const r of rows) {
    const src = r.sourceCount === null ? '-' : r.sourceCount.toString();
    const tgt = r.targetCount === null ? '-' : r.targetCount.toString();
    const diff = r.diff === null ? '-' : r.diff.toString();
    const statusIcon =
      r.status === 'match' ? '✓ match' :
      r.status === 'diff' ? '✗ diff' :
      '⚠ error';
    lines.push(`| \`${r.table}\` | ${src} | ${tgt} | ${diff} | ${statusIcon} | ${r.error ?? ''} |`);
  }
  return lines.join('\n');
}

main().catch(err => {
  console.error('uncaught:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
