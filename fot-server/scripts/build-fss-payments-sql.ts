/**
 * Реестр «Прямые выплаты ФСС» ЗУП за месяц (XML) → SQL загрузки в «Выплаты ФСС (1С)» (миграция 356), SQL отката,
 * сверка xlsx и manifest. Решение пользователя 10.11.2026: больничный с 4-го дня СФР платит напрямую — показывать на
 * «Расчётах» отдельным столбцом; в «Сумму» и «Остаток» не входит.
 *
 * Разбор — payroll-fss.parser.ts (суммы как в 1С). Сотрудник — по физлицу (ФИО + id_all), как у ведомостей выплаты
 * (payouts-person-decision.ts): id_all → один кандидат по ФИО → тёзки: работал в месяце → ранее подтверждён под этим
 * ФИО → иначе без сотрудника. Стоп: то же ФИО в «Перечислено (1С)» этого месяца сопоставлено с другим сотрудником.
 *
 * Работает на read-only проде (роль mcp_readonly из --env-file) и в базу ничего не пишет; таблица 356 для сборки не
 * нужна. Файлы — в --out-dir, права 600, не в git (ФИО и суммы). Исходники с незакоммиченными правками — отказ: SQL и
 * manifest подписаны HEAD. SQL — с открытой транзакцией: \i в интерактивном psql, сверка КОНТРОЛЯ, затем COMMIT; или
 * ROLLBACK;. Запускать после миграции 356.
 *
 * Запуск:
 *   cd fot-server && TZ=UTC npx tsx scripts/build-fss-payments-sql.ts --file <xml> --month 2026-09 \
 *     [--out-dir ~] [--env-file ~/.config/mcp/env] [--database FOT_Prod]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

import type { IPayoutCandidate } from '../src/services/payroll/payroll-1c-payouts.matching.js';
import { normalizePayoutName } from '../src/services/payroll/payroll-1c-payouts.parser.js';
import { parseFssRegistryXml, type IFssLine } from '../src/services/payroll/payroll-fss.parser.js';
import { buildFssLoadSql, buildFssRollbackSql, type IFssSqlInput, type IFssSqlLine } from './lib/fss-payments-sql.js';
import { decide, DECISION_LABELS, decisionLabel, type DecisionKind, type IDecision } from './lib/payouts-person-decision.js';

const TAG = '[build-fss-payments-sql]';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Исходники, от которых зависит результат: с незакоммиченными правками генератор не работает. */
const SOURCE_PATHS = [
  'fot-server/scripts/build-fss-payments-sql.ts',
  'fot-server/scripts/lib/fss-payments-sql.ts',
  'fot-server/scripts/lib/payouts-person-decision.ts',
  'fot-server/src/services/payroll/payroll-fss.parser.ts',
  'fot-server/src/services/payroll/payroll-1c-payouts.month-xml.ts',
  'fot-server/src/services/payroll/payroll-1c-payouts.parser.ts',
  'fot-server/src/services/payroll/payroll-1c-payouts.matching.ts',
  'fot-server/src/config/postgres.ts',
  'fot-server/src/config/env.ts',
  'docs/migrations/356_payroll_fss_payments.sql',
];

interface IArgs { file: string; month: string; outDir: string; envFile: string; database: string }

const parseArgs = (argv: readonly string[]): IArgs => {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (!['--file', '--month', '--out-dir', '--env-file', '--database'].includes(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Неизвестный или пустой аргумент «${name}»`);
    }
    values.set(name, value);
  }
  const file = values.get('--file');
  const month = values.get('--month');
  if (!file || !month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Нужны --file <xml> и --month YYYY-MM');
  return {
    file,
    month,
    outDir: values.get('--out-dir') ?? os.homedir(),
    envFile: values.get('--env-file') ?? path.join(os.homedir(), '.config', 'mcp', 'env'),
    database: values.get('--database') ?? 'FOT_Prod',
  };
};

const git = (...gitArgs: string[]): string => execFileSync('git', gitArgs, { cwd: REPO }).toString().trim();

const sourceHead = (): string => {
  const dirty = git('status', '--porcelain', '--', ...SOURCE_PATHS);
  if (dirty) throw new Error(`Незакоммиченные правки в исходниках генератора — сначала коммит:\n${dirty}`);
  return git('rev-parse', '--short', 'HEAD');
};

/** Read-only роль прода — до импорта config/postgres: env.ts читает переменные при импорте. Значения не печатаются. */
const loadReadonlyEnv = (envFile: string): void => {
  const vars = new Map<string, string>();
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (match) vars.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const url = vars.get('FOT_MCP_PGURL');
  const password = vars.get('FOT_MCP_PGPASSWORD');
  if (!url || !password) throw new Error(`${envFile}: нет FOT_MCP_PGURL или FOT_MCP_PGPASSWORD`);
  process.env.DATABASE_URL = url;
  process.env.PGPASSWORD = password;
  process.env.DATABASE_SSL_CA_PATH = path.join(REPO, '.migration', 'yandex-ca.pem');
  // У роли лимит подключений; при NODE_ENV=test env.ts не перетирает переменные значениями fot-server/.env.
  process.env.DATABASE_POOL_MAX = process.env.DATABASE_POOL_MAX ?? '1';
  process.env.NODE_ENV = 'test';
};

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const rub = (cents: number): string => (cents / 100)
  .toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  .replace(/ /g, ' ');
const num = (cents: number): string => (cents / 100).toFixed(2);
const ruDate = (iso: string | null): string => (iso ? iso.split('-').reverse().join('.') : '');
const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const writePrivate = (file: string, content: string | Buffer): void => {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

/** Физлицо реестра: нормализованное ФИО + id_all. */
interface IPerson { key: string; fullName: string; idAll: string | null; lines: IFssLine[] }

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const gitHead = sourceHead();
  loadReadonlyEnv(args.envFile);
  const { query, closeDb } = await import('../src/config/postgres.js');
  const { loadPayoutEligibility, matchPayoutLines, SQL_NAME } = await import('../src/services/payroll/payroll-1c-payouts.matching.js');
  try {
    const [role] = await query<{ who: string; can_insert: boolean }>(
      `SELECT current_user AS who, has_table_privilege('public.payroll_1c_payout_documents', 'INSERT') AS can_insert`,
    );
    if (role?.who !== 'mcp_readonly' || role.can_insert) {
      throw new Error(`Нужна read-only роль mcp_readonly без права записи, а подключено: ${role?.who ?? '?'}`);
    }

    const source = fs.readFileSync(args.file);
    const sourceSha = sha256(source);
    const periodMonth = `${args.month}-01`;
    const monthLabel = `${args.month.slice(5)}.${args.month.slice(0, 4)}`;
    const registry = parseFssRegistryXml(source.toString('utf8'), args.month);
    const prefix = `ФСС ${monthLabel} (реестр ${registry.docNumber})`;

    // Физлица и кандидаты.
    const persons = new Map<string, IPerson>();
    for (const line of registry.lines) {
      const key = `${normalizePayoutName(line.fullName)}|${line.personIdAll ?? ''}`;
      const person = persons.get(key) ?? { key, fullName: line.fullName, idAll: line.personIdAll, lines: [] };
      person.lines.push(line);
      persons.set(key, person);
    }
    const matches = await matchPayoutLines({
      periodMonth,
      lines: [...persons.values()].map((person, index) => ({
        lineNo: index + 1, fullName: person.fullName, personIdAll: person.idAll, brigade: null, amountCents: 0, lineKey: person.key,
      })),
    });
    const names = [...new Set([...persons.values()].map(person => normalizePayoutName(person.fullName)))];
    const earlierRows = await query<{ name_key: string; employee_id: number }>(
      `SELECT DISTINCT ${SQL_NAME('l.full_name_1c')} AS name_key, l.employee_id FROM payroll_1c_payout_lines l
        WHERE l.employee_id IS NOT NULL AND l.resolution IN ('auto_id_all', 'confirmed')
          AND ${SQL_NAME('l.full_name_1c')} = ANY($1::text[])`,
      [names],
    );
    const earlierByName = new Map<string, Set<number>>();
    for (const row of earlierRows) {
      earlierByName.set(row.name_key, new Set([...(earlierByName.get(row.name_key) ?? []), Number(row.employee_id)]));
    }
    const candidatesOf = (person: IPerson): IPayoutCandidate[] => matches.get(person.key)?.candidates ?? [];
    const candidateIds = [...new Set([...persons.values()].flatMap(person => candidatesOf(person).map(c => c.employee_id)))];
    const firedNoDate = new Set((await query<{ id: number }>(
      `SELECT id FROM employees WHERE id = ANY($1::int[]) AND employment_status = 'fired' AND dismissal_date IS NULL`,
      [candidateIds],
    )).map(row => Number(row.id)));
    const decisions = new Map<string, IDecision>([...persons.values()].map(person => [person.key, decide(
      candidatesOf(person), matches.get(person.key)?.auto_employee_id ?? null,
      earlierByName.get(normalizePayoutName(person.fullName)) ?? new Set(), firedNoDate,
    )]));
    const decisionOf = (person: IPerson): IDecision => {
      const decision = decisions.get(person.key);
      if (!decision) throw new Error(`Нет решения: ${person.fullName}`);
      return decision;
    };

    const finalIds = [...new Set([...decisions.values()].map(d => d.employeeId).filter((id): id is number => id !== null))];
    const info = await loadPayoutEligibility(finalIds, periodMonth);
    for (const id of finalIds) {
      if (!info.get(id)) throw new Error(`Сотрудник ${id} не найден`);
      if (!info.get(id)?.eligible) throw new Error(`Сотрудник ${id} в месяце у подрядчика`);
    }

    // То же ФИО в «Перечислено (1С)» этого месяца сопоставлено с другим сотрудником — стоп.
    const monthRows = await query<{ name_key: string; employee_id: number | null }>(
      `SELECT DISTINCT ${SQL_NAME('l.full_name_1c')} AS name_key, l.employee_id FROM payroll_1c_payout_lines l
         JOIN payroll_1c_payout_documents d ON d.id = l.document_id
        WHERE d.period_month = $1::date AND ${SQL_NAME('l.full_name_1c')} = ANY($2::text[])`,
      [periodMonth, names],
    );
    const monthByName = new Map<string, Set<number | null>>();
    for (const row of monthRows) {
      monthByName.set(row.name_key, new Set([...(monthByName.get(row.name_key) ?? []),
        row.employee_id === null ? null : Number(row.employee_id)]));
    }
    const conflicts = [...persons.values()].flatMap(person => {
      const before = monthByName.get(normalizePayoutName(person.fullName));
      const id = decisionOf(person).employeeId;
      return before && (before.size !== 1 || !before.has(id))
        ? [`${person.fullName}: сотрудник ${id ?? '—'}, в «Перечислено (1С)» месяца — ${[...before].map(v => v ?? '—').join(', ')}`]
        : [];
    });
    if (conflicts.length > 0) {
      throw new Error(`Сотрудник не совпал с «Перечислено (1С)» месяца (${conflicts.length}) — решить до загрузки:\n  ${conflicts.join('\n  ')}`);
    }

    const personByLine = new Map<IFssLine, IPerson>();
    for (const person of persons.values()) for (const line of person.lines) personByLine.set(line, person);
    const sqlLines: IFssSqlLine[] = registry.lines.map(line => {
      const person = personByLine.get(line);
      if (!person) throw new Error(`Строка без физлица: ${line.fullName}`);
      const decision = decisionOf(person);
      const resolutionReason = `${prefix}: ${decisionLabel(decision.kind)}`;
      if (line.fullName.length > 300 || resolutionReason.length > 300) throw new Error(`Слишком длинное поле строки: ${line.fullName}`);
      return {
        ...line,
        employeeId: decision.employeeId,
        employeeName: decision.employeeId === null ? null : (info.get(decision.employeeId)?.full_name ?? null),
        resolutionReason,
      };
    });

    const cents = (lines: readonly IFssSqlLine[], key: 'grossCents' | 'ndflCents' | 'amountCents' = 'amountCents'): number => (
      lines.reduce((sum, line) => sum + line[key], 0)
    );
    const matched = sqlLines.filter(line => line.employeeId !== null);
    const unmatched = sqlLines.filter(line => line.employeeId === null);
    const roundingLines = sqlLines.filter(line => line.grossCents - line.ndflCents !== line.amountCents);

    // Примеры для контроля: два сотрудника с наибольшей суммой.
    const byEmployee = new Map<number, number>();
    for (const line of matched) byEmployee.set(line.employeeId as number, (byEmployee.get(line.employeeId as number) ?? 0) + line.amountCents);
    const samples = [...byEmployee.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 2).map(([id]) => id);
    const sampleText = (loaded: boolean) => samples.map(id => `${info.get(id)?.full_name} (${id}) ${loaded ? num(byEmployee.get(id) ?? 0) : '0.00'}`)
      .join('; ');

    const registryWhere = `registry_guid = ${sqlText(registry.guid)}::uuid`;
    const controls = (label: string, loaded: boolean): string[] => {
      const pick = (lines: readonly IFssSqlLine[], key?: 'grossCents' | 'ndflCents') => (loaded ? num(cents(lines, key)) : '0.00');
      return [
        `\\echo 'КОНТРОЛЬ реестр ${registry.docNumber} ${label}: строк ${loaded ? sqlLines.length : 0} / всего ${pick(sqlLines, 'grossCents')}`
          + ` / НДФЛ ${pick(sqlLines, 'ndflCents')} / на руки ${pick(sqlLines)}; с сотрудником ${loaded ? matched.length : 0} / ${pick(matched)};`
          + ` без ${loaded ? unmatched.length : 0} / ${pick(unmatched)}'`,
        `SELECT count(*) AS lines, COALESCE(sum(amount_gross), 0)::text AS gross, COALESCE(sum(ndfl), 0)::text AS ndfl,
       COALESCE(sum(amount), 0)::text AS amount, count(employee_id) AS lines_emp,
       COALESCE(sum(amount) FILTER (WHERE employee_id IS NOT NULL), 0)::text AS amount_emp,
       count(*) - count(employee_id) AS lines_none, COALESCE(sum(amount) FILTER (WHERE employee_id IS NULL), 0)::text AS amount_none
  FROM payroll_fss_payments WHERE ${registryWhere};`,
        ...(samples.length === 0 ? [] : [
          `\\echo 'КОНТРОЛЬ люди за ${monthLabel} (на руки): ${sampleText(loaded)}'`,
          `SELECT e.id, e.full_name, COALESCE(sum(f.amount), 0)::text AS fss FROM employees e
  LEFT JOIN payroll_fss_payments f ON f.employee_id = e.id AND f.${registryWhere}
 WHERE e.id IN (${samples.join(', ')}) GROUP BY 1, 2 ORDER BY 2;`,
        ]),
      ];
    };

    // Сверка xlsx.
    const sorted = [...sqlLines].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru') || a.lineNo - b.lineNo);
    const kindOf = (line: IFssSqlLine): DecisionKind => decisionOf(personByLine.get(registry.lines[line.lineNo - 1]) as IPerson).kind;
    const kindCount = (kind: DecisionKind) => [...persons.values()].filter(person => decisionOf(person).kind === kind).length;
    const summary: unknown[][] = [
      ['', 'Строк', 'Всего', 'НДФЛ', 'На руки'],
      ['Реестр', sqlLines.length, cents(sqlLines, 'grossCents') / 100, cents(sqlLines, 'ndflCents') / 100, cents(sqlLines) / 100],
      ['С сотрудником', matched.length, cents(matched, 'grossCents') / 100, cents(matched, 'ndflCents') / 100, cents(matched) / 100],
      ['Без сотрудника', unmatched.length, cents(unmatched, 'grossCents') / 100, cents(unmatched, 'ndflCents') / 100, cents(unmatched) / 100],
      [],
      ['Реестр', `${registry.docNumber} от ${ruDate(registry.docDate)}, месяц ${monthLabel}`],
      ['Сотрудников', finalIds.length],
      ['Физлиц в реестре (ФИО + id_all)', persons.size],
      ...DECISION_LABELS.map(([kind, label]) => [`Физлиц: ${label}`, kindCount(kind)]),
      ['«На руки» ≠ всего − НДФЛ (как в 1С, не пересчитано)', roundingLines.length],
    ];
    const all: unknown[][] = [['ФИО 1С', 'id', 'ФИО в ФОТ', 'Отдел в месяце', 'Сопоставление', '№ ЭЛН', 'Причина', 'С', 'По', 'Дней',
      'Всего', 'НДФЛ', 'На руки']];
    const notFound: unknown[][] = [['ФИО 1С', 'На руки', 'С', 'По']];
    const review: unknown[][] = [['ФИО 1С', 'id', 'ФИО в ФОТ', 'Что проверить']];
    for (const line of sorted) {
      const employee = line.employeeId === null ? null : info.get(line.employeeId);
      const kind = kindOf(line);
      all.push([line.fullName, line.employeeId, employee?.full_name ?? null, employee?.department ?? null, decisionLabel(kind),
        line.sickLeaveNumber, line.reason, ruDate(line.dateFrom), ruDate(line.dateTo), line.days,
        line.grossCents / 100, line.ndflCents / 100, line.amountCents / 100]);
      if (kind === 'none' || kind === 'ambiguous') notFound.push([line.fullName, line.amountCents / 100, ruDate(line.dateFrom), ruDate(line.dateTo)]);
      const notes: string[] = [];
      if (line.grossCents - line.ndflCents !== line.amountCents) {
        notes.push(`на руки ${num(line.amountCents)} ≠ всего ${num(line.grossCents)} − НДФЛ ${num(line.ndflCents)} (взято как в 1С)`);
      }
      if (kind === 'worked' || kind === 'earlier') notes.push(decisionLabel(kind));
      if (employee?.dismissal_date && employee.dismissal_date < periodMonth) notes.push(`уволен в ФОТ ${ruDate(employee.dismissal_date)} — до начала месяца`);
      if (employee && !employee.workedInMonth) notes.push('по датам приёма и увольнения в месяце не работал');
      if (notes.length > 0) review.push([line.fullName, line.employeeId, employee?.full_name ?? null, notes.join('; ')]);
    }
    const book = XLSX.utils.book_new();
    const addSheet = (title: string, rows: unknown[][], widths: number[]) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = widths.map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(book, ws, title);
    };
    addSheet('Итоги', summary, [52, 10, 16, 16, 16]);
    addSheet('Все', all, [36, 8, 36, 30, 32, 16, 20, 12, 12, 8, 14, 12, 14]);
    addSheet('Не найдены', notFound, [36, 14, 12, 12]);
    addSheet('Проверить', review, [36, 8, 36, 80]);

    const base = path.join(args.outDir, `payroll-fss-${args.month}`);
    const files = {
      sql: `${base}.sql`,
      rollback: `${base}-rollback.sql`,
      report: path.join(args.outDir, `ФСС_${args.month}_сверка.xlsx`),
      manifest: `${base}.manifest.json`,
    };
    const existing = Object.values(files).filter(file => fs.existsSync(file));
    if (existing.length > 0) throw new Error(`Файлы уже есть — не перезаписываю:\n  ${existing.join('\n  ')}`);
    const header = [
      `Зарплата → «Выплаты ФСС (1С)» (миграция 356): прямые выплаты СФР по больничным за ${monthLabel}`,
      `(«${path.basename(args.file)}», sha256 ${sourceSha}).`,
      `Реестр ${registry.docNumber} от ${ruDate(registry.docDate)}: строк ${sqlLines.length}, всего ${rub(cents(sqlLines, 'grossCents'))},`
        + ` НДФЛ ${rub(cents(sqlLines, 'ndflCents'))}, на руки ${rub(cents(sqlLines))}.`,
      `С сотрудником: строк ${matched.length} на ${rub(cents(matched))}, сотрудников ${finalIds.length};`
        + ` без сотрудника: строк ${unmatched.length} на ${rub(cents(unmatched))}.`,
      `Суммы — как в 1С; «на руки» ≠ всего − НДФЛ у ${roundingLines.length} строк (лист «Проверить»).`,
      'В расчёт ФОТ, «Остаток» и «Выплаты на карту» не входит — только столбец «Выплаты ФСС (1С)» на «Расчётах».',
      `Сверка: ${path.basename(files.report)}; manifest: ${path.basename(files.manifest)}.`,
      '',
      'Состояния: строк реестра нет → вставка; ровно этот набор → без изменений; иначе → ошибка, ничего не записано.',
      `Запуск (после миграции 356): psql, затем \\i ${path.basename(files.sql)} → NOTICE «Вставлено строк ФСС: ${sqlLines.length}»`,
      'и КОНТРОЛЬ; транзакция остаётся открытой: COMMIT; если всё верно, ROLLBACK; если нет. После ошибки — ROLLBACK;.',
      `Откат (только по решению): ${path.basename(files.rollback)}.`,
      `Собрано ${new Date().toISOString()} из ${gitHead} (scripts/build-fss-payments-sql.ts).`,
    ];
    const input: IFssSqlInput = {
      header,
      registry: {
        guid: registry.guid, docNumber: registry.docNumber, docDate: registry.docDate, periodMonth: registry.periodMonth,
        contentHash: registry.contentHash,
      },
      lines: sqlLines,
    };
    writePrivate(files.sql, buildFssLoadSql(input, { database: args.database, controls: controls('после загрузки', true) }));
    writePrivate(files.rollback, buildFssRollbackSql(
      { ...input, header: [...header.slice(0, 2), 'ОТКАТ: удаляет все строки реестра, только если их не меняли после загрузки.'] },
      { database: args.database, controls: controls('после отката', false) },
    ));
    writePrivate(files.report, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    const fileSha = (file: string) => sha256(fs.readFileSync(file));
    writePrivate(files.manifest, `${JSON.stringify({
      generated_at: new Date().toISOString(),
      git_head: gitHead,
      month: args.month,
      source: { file: path.basename(args.file), sha256: sourceSha },
      registry: { guid: registry.guid, number: registry.docNumber, date: registry.docDate, content_hash: registry.contentHash },
      counts: {
        lines: sqlLines.length, gross: num(cents(sqlLines, 'grossCents')), ndfl: num(cents(sqlLines, 'ndflCents')), amount: num(cents(sqlLines)),
        matched_lines: matched.length, matched_amount: num(cents(matched)), unmatched_lines: unmatched.length,
        unmatched_amount: num(cents(unmatched)), employees: finalIds.length, rounding_lines: roundingLines.length,
        decisions: Object.fromEntries(DECISION_LABELS.map(([kind]) => [kind, kindCount(kind)])),
      },
      samples: sampleText(true),
      outputs: {
        sql: { file: path.basename(files.sql), sha256: fileSha(files.sql) },
        rollback: { file: path.basename(files.rollback), sha256: fileSha(files.rollback) },
        report: { file: path.basename(files.report), sha256: fileSha(files.report) },
      },
    }, null, 2)}\n`);

    console.log(`${TAG} реестр ${registry.docNumber}: строк ${sqlLines.length}, всего ${rub(cents(sqlLines, 'grossCents'))},`
      + ` НДФЛ ${rub(cents(sqlLines, 'ndflCents'))}, на руки ${rub(cents(sqlLines))}`);
    console.log(`${TAG} с сотрудником: строк ${matched.length} (${rub(cents(matched))}), сотрудников ${finalIds.length};`
      + ` без: строк ${unmatched.length} (${rub(cents(unmatched))}); проверить ${review.length - 1}`);
    console.log(`${TAG} решения: ${DECISION_LABELS.map(([kind, label]) => `${label} ${kindCount(kind)}`).join('; ')}`);
    for (const file of Object.values(files)) console.log(`${TAG} ${file}`);
  } finally {
    await closeDb();
  }
};

main().catch(err => {
  console.error(`${TAG} ОШИБКА: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
