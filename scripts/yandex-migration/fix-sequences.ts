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
//
// Зависимостей нет (psql shell-out).

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
  npm run migrate:yandex:fix-sequences -- [--dry-run] [--report PATH]

ENV:
  TARGET_DATABASE_URL   postgres://...  (required) — Yandex Managed PG

Что делает:
  1. Перечисляет public sequences, привязанные к колонкам через pg_depend
     (т. е. сгенерированные через SERIAL/BIGSERIAL/GENERATED AS IDENTITY).
  2. Для каждой: SELECT GREATEST(COALESCE(MAX(<col>), 0), 1) FROM public.<t>.
  3. Если данные есть — setval(seq, max, true); если пусто — setval(seq, 1, false).
  4. Сохраняет markdown-отчёт.

--dry-run печатает SQL без выполнения. По умолчанию — apply.

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

function psqlScalar(url: string, sql: string): string {
  const r = spawnSync('psql', [url, '-tA', '--no-psqlrc', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function psqlRows(url: string, sql: string, sep = '\t'): string[][] {
  const r = spawnSync('psql', [url, '-tA', `-F${sep}`, '--no-psqlrc', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  const out = (r.stdout || '').trim();
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
  status: 'ok' | 'error';
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

    const hasData = maxValue !== null && Number.isFinite(maxValue) && maxValue > 0;
    const setvalArg = hasData ? maxValue : 1;
    const isCalled = hasData;
    // setval(seq, n, true)  → следующее nextval вернёт n+1
    // setval(seq, 1, false) → следующее nextval вернёт 1
    const setvalSql = `SELECT pg_catalog.setval(pg_get_serial_sequence('"${s.schema}"."${safeTbl}"', '${safeCol}'), ${setvalArg}, ${isCalled ? 'true' : 'false'});`;

    if (args.dryRun) {
      console.log(`-- ${s.schema}.${s.sequence} (max=${maxValue ?? 'null'})`);
      console.log(setvalSql);
      results.push({ ...s, maxValue, newSetval: setvalArg, isCalled, status: 'ok' });
      continue;
    }

    try {
      psqlScalar(url, setvalSql);
      results.push({ ...s, maxValue, newSetval: setvalArg, isCalled, status: 'ok' });
      console.log(`✓ ${s.schema}.${s.sequence} → setval(${setvalArg}, ${isCalled}) (table=${s.table}.${s.column} max=${maxValue ?? 'null'})`);
    } catch (err) {
      results.push({ ...s, maxValue, newSetval: setvalArg, isCalled, status: 'error', error: (err as Error).message });
      console.error(`✗ ${s.schema}.${s.sequence}: ${(err as Error).message}`);
    }
  }

  ensureDir(args.report);
  writeFileSync(args.report, renderMd(results, args.dryRun), 'utf8');

  const okCount = results.filter(r => r.status === 'ok').length;
  const errCount = results.filter(r => r.status === 'error').length;
  console.log(`\nok=${okCount} error=${errCount} report=${args.report}`);

  process.exit(errCount > 0 ? 1 : 0);
}

function renderMd(rows: ISeqResult[], dryRun: boolean): string {
  const lines: string[] = [];
  lines.push('# fix-sequences report');
  lines.push('');
  lines.push(`- Started: ${new Date().toISOString()}`);
  lines.push(`- Mode: ${dryRun ? 'dry-run' : 'apply'}`);
  lines.push(`- Total sequences: ${rows.length}`);
  lines.push(`- OK: ${rows.filter(r => r.status === 'ok').length}`);
  lines.push(`- Errors: ${rows.filter(r => r.status === 'error').length}`);
  lines.push('');
  lines.push('| Schema | Sequence | Table | Column | max(col) | setval | is_called | Status | Error |');
  lines.push('|---|---|---|---|---:|---:|---|---|---|');
  for (const r of rows) {
    lines.push(
      `| ${r.schema} | ${r.sequence} | ${r.table} | ${r.column} | ` +
        `${r.maxValue ?? '-'} | ${r.newSetval} | ${r.isCalled} | ` +
        `${r.status === 'ok' ? '✓' : '✗'} | ${r.error ?? ''} |`,
    );
  }
  return lines.join('\n') + '\n';
}

main().catch(err => {
  console.error('uncaught:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
