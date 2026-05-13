// fix-sequences.ts
// После pg_restore --data-only sequence-counters не обновляются — следующий
// INSERT с DEFAULT nextval(seq) сразу же столкнётся с PK-конфликтом, потому
// что seq.last_value < max(id).
//
// Скрипт обходит все public-sequences, привязанные к колонкам через
// pg_depend (т. е. реальные SERIAL/BIGSERIAL/IDENTITY), и выполняет setval
// на основе текущего MAX(col) в owning-таблице.
//
// Запуск из fot-server:
//   npm run migrate:yandex:fix-sequences
//   npm run migrate:yandex:fix-sequences -- --dry-run
//   npm run migrate:yandex:fix-sequences -- --help
//
// Зависимостей нет (psql shell-out через stdin, не через -c, чтобы избежать
// проблем с Windows escape для double-quoted идентификаторов).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPORT_DEFAULT = '.migration/sequences_report.md';

interface IArgs {
  report: string;
  dryRun: boolean;
  help: boolean;
}

const HELP = `fix-sequences — обновить SERIAL-counter'ы после pg_restore --data-only

Usage:
  npm run migrate:yandex:fix-sequences -- [--dry-run] [--report PATH] [--help]

ENV:
  TARGET_DATABASE_URL   postgres://...  (required) — Yandex Managed PG.

Опции:
  --dry-run             печатает план без выполнения setval. apply по default.
  --report PATH         markdown-отчёт (default: ${REPORT_DEFAULT}).
  --help, -h            эта справка.

Что делает:
  1. Перечисляет public sequences, привязанные к колонкам через pg_depend
     (т. е. сгенерированные через SERIAL/BIGSERIAL/GENERATED AS IDENTITY).
  2. Для каждой: SELECT COALESCE(MAX(<col>), 0) FROM public.<t>.
  3. Если данные есть — setval(seq, max, true); иначе setval(seq, 1, false).
  4. Сохраняет markdown-отчёт.

Технические детали:
  SQL передаётся в psql через stdin (\`-f -\`), а не через \`-c "..."\` —
  это обходит баг Windows spawnSync escape, при котором двойные кавычки
  внутри SQL-идентификаторов рвут команду.

Exit codes:
  0 — все sequences обработаны
  1 — была хотя бы одна ошибка
  2 — ENV/psql ошибка
`;

function parseArgs(argv: readonly string[]): IArgs {
  const out: IArgs = { report: REPORT_DEFAULT, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--report') out.report = argv[++i];
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  return out;
}

/**
 * Запускает psql, передавая SQL через stdin (через `-f -`).
 * Это обходит Windows spawnSync арг-эскейпинг для double-quoted идентификаторов.
 */
function psqlStdin(url: string, sql: string, extraArgs: string[] = []): string {
  const args = [url, '-tA', '--no-psqlrc', '--single-transaction', '-v', 'ON_ERROR_STOP=1', ...extraArgs, '-f', '-'];
  const r = spawnSync('psql', args, { input: sql, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function psqlScalar(url: string, sql: string): string {
  return psqlStdin(url, sql);
}

function psqlRows(url: string, sql: string, sep = '\t'): string[][] {
  const out = psqlStdin(url, sql, [`-F${sep}`]);
  if (!out) return [];
  return out.split('\n').map(l => l.split(sep));
}

function ensureDir(filePath: string): void {
  const d = dirname(resolve(filePath));
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

interface ISeqInfo {
  schema: string;
  sequence: string;
  table: string;
  column: string;
}

interface ISeqResult extends ISeqInfo {
  maxValue: number | null;
  newSetval: number;
  isCalled: boolean;
  status: 'ok' | 'error' | 'planned';
  error?: string;
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

  const url = process.env.TARGET_DATABASE_URL;
  if (!url) {
    console.error('ERROR: TARGET_DATABASE_URL не задан');
    process.exit(2);
  }

  // sanity
  try {
    const ver = psqlScalar(url, 'SELECT version();');
    console.log('target:', ver);
  } catch (err) {
    console.error('ERROR: psql connect failed:', (err as Error).message);
    process.exit(2);
  }

  // Все public-sequences, привязанные к колонкам owning-таблиц.
  // pg_depend.deptype='a' = auto-generated dependency для SERIAL/IDENTITY.
  const listSql = `
    SELECT
      ns_s.nspname     AS seq_schema,
      c_s.relname      AS seq_name,
      ns_t.nspname     AS tbl_schema,
      c_t.relname      AS tbl_name,
      a.attname        AS col_name
    FROM pg_class c_s
    JOIN pg_namespace ns_s ON ns_s.oid = c_s.relnamespace
    JOIN pg_depend d       ON d.objid = c_s.oid AND d.deptype = 'a'
    JOIN pg_class c_t      ON c_t.oid = d.refobjid
    JOIN pg_namespace ns_t ON ns_t.oid = c_t.relnamespace
    JOIN pg_attribute a    ON a.attrelid = c_t.oid AND a.attnum = d.refobjsubid
    WHERE c_s.relkind = 'S'
      AND ns_s.nspname = 'public'
      AND ns_t.nspname = 'public'
    ORDER BY 1, 2;
  `;
  const sequences: ISeqInfo[] = psqlRows(url, listSql).map(row => ({
    schema: row[0],
    sequence: row[1],
    table: row[3],
    column: row[4],
  }));

  console.log(`public sequences attached to columns: ${sequences.length}`);

  const results: ISeqResult[] = [];
  for (const s of sequences) {
    // Все идентификаторы — exactly как pg_depend их вернул (validated).
    // SQL генерируется как одна строка, ничего не concatenating с user-input.
    const safeTbl = s.table.replace(/"/g, '""');
    const safeCol = s.column.replace(/"/g, '""');
    const maxQ = `SELECT COALESCE(MAX("${safeCol}")::text, '') FROM "${s.schema}"."${safeTbl}";`;
    let maxValue: number | null = null;
    try {
      const raw = psqlScalar(url, maxQ);
      maxValue = raw === '' ? null : Number.parseInt(raw, 10);
    } catch (err) {
      results.push({ ...s, maxValue: null, newSetval: 0, isCalled: false, status: 'error', error: (err as Error).message });
      continue;
    }

    const hasData = maxValue !== null && maxValue > 0;
    const isCalled = hasData;
    const setvalArg = hasData ? maxValue : 1;

    // setval(seq, n, true)  → следующее nextval вернёт n+1
    // setval(seq, 1, false) → следующее nextval вернёт 1
    const safeSeq = s.sequence.replace(/"/g, '""');
    const setvalSql = `SELECT pg_catalog.setval('"${s.schema}"."${safeSeq}"', ${setvalArg}, ${isCalled ? 'true' : 'false'});`;
    if (args.dryRun) {
      console.log('[DRY] ' + setvalSql);
      results.push({ ...s, maxValue, newSetval: setvalArg, isCalled, status: 'planned' });
      continue;
    }
    try {
      psqlScalar(url, setvalSql);
      results.push({ ...s, maxValue, newSetval: setvalArg, isCalled, status: 'ok' });
      console.log(`✓ ${s.schema}.${s.sequence} → setval(${setvalArg}, ${isCalled}) (table=${s.table}.${s.column} max=${maxValue ?? 'null'})`);
    } catch (err) {
      results.push({ ...s, maxValue, newSetval: setvalArg, isCalled, status: 'error', error: (err as Error).message });
    }
  }

  // Markdown report
  const okCount = results.filter(r => r.status === 'ok').length;
  const plannedCount = results.filter(r => r.status === 'planned').length;
  const errorCount = results.filter(r => r.status === 'error').length;

  const lines: string[] = [];
  lines.push('# fix-sequences report');
  lines.push('');
  lines.push(`- Started: ${new Date().toISOString()}`);
  lines.push(`- Mode: ${args.dryRun ? 'dry-run' : 'apply'}`);
  lines.push(`- Total sequences: ${sequences.length}`);
  lines.push(`- OK: ${okCount}`);
  if (args.dryRun) lines.push(`- Planned (dry-run): ${plannedCount}`);
  lines.push(`- Errors: ${errorCount}`);
  lines.push('');
  lines.push('| Schema | Sequence | Table | Column | max(col) | setval | is_called | Status | Error |');
  lines.push('|---|---|---|---|---:|---:|---|---|---|');
  for (const r of results) {
    const statusIcon = r.status === 'ok' ? '✓' : r.status === 'planned' ? '⏸' : '✗';
    lines.push(
      `| ${r.schema} | ${r.sequence} | ${r.table} | ${r.column} | ${r.maxValue ?? '-'} | ${r.newSetval} | ${r.isCalled ? 'true' : 'false'} | ${statusIcon} | ${(r.error ?? '').replace(/\|/g, '\\|')} |`,
    );
  }
  ensureDir(args.report);
  writeFileSync(args.report, lines.join('\n') + '\n', 'utf8');

  console.log('');
  console.log(`ok=${okCount} ${args.dryRun ? `planned=${plannedCount} ` : ''}error=${errorCount} report=${args.report}`);
  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('uncaught:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
