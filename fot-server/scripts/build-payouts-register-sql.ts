/**
 * Регистр выплат ЗУП за месяц (xlsx «ВыгрузкаЗУП_представительской…») → SQL загрузки в «Перечислено (1С)»
 * (миграция 328), SQL отката, сверка xlsx и manifest. Решение пользователя 28.10.2026: выплаты сентября — разовым
 * скриптом, без кнопки.
 *
 * Сопоставление — как у загрузки XML (matchPayoutLines): кандидаты по ФИО, подрядчик в месяце не кандидат.
 * Подразделение 1С идёт как бригада. Один кандидат → сотрудник; несколько → по бригаде, отделу табеля месяца,
 * «работал в месяце»; не однозначно или никого → строка «без сотрудника» и лист сверки. Решения пользователя —
 * --overrides (JSON), строго: id только из кандидатов (другое написание ФИО — явным name_mismatch), подрядчик
 * запрещён, неиспользованное или конфликтующее правило — ошибка.
 *
 * Работает на read-only проде (роль mcp_readonly из --env-file) и в базу ничего не пишет. Файлы — в --out-dir,
 * права 600, не в git (ФИО и суммы).
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/build-payouts-register-sql.ts --file <регистр.xlsx> --month 2026-09 \
 *     [--overrides <решения.json>] [--out-dir ~] [--env-file ~/.config/mcp/env]
 * Затем на проде: psql -X -v ON_ERROR_STOP=1 -f payroll-1c-payouts-<месяц>.sql
 *
 * Формат --overrides: { "rules": [{ "key": "<Регистратор>|<НомерСтроки>" или "<ФИО>|<Подразделение>",
 *   "employee_id": 123 | null, "name_mismatch"?: true, "note"?: "…" }] }
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

import type { IPayoutCandidate } from '../src/services/payroll/payroll-1c-payouts.matching.js';
import { normalizePayoutName } from '../src/services/payroll/payroll-1c-payouts.parser.js';
import {
  buildRegisterDocuments,
  type IRegisterDocument,
  type IRegisterLine,
} from '../src/services/payroll/payroll-1c-payouts.register.js';
import { buildRegisterLoadSql, buildRegisterRollbackSql, type IRegisterSqlLine } from './lib/payouts-register-sql.js';

const TAG = '[build-payouts-register-sql]';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROW_KEY_RE = /^(Ведомость (?:в банк|на счета) \d{4}-\d{6} от \d{2}\.\d{2}\.\d{4})\|(\d+)$/;

interface IArgs { file: string; month: string; overrides: string | null; outDir: string; envFile: string }

const parseArgs = (argv: readonly string[]): IArgs => {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (!['--file', '--month', '--overrides', '--out-dir', '--env-file'].includes(name) || value === undefined) {
      throw new Error(`Неизвестный или пустой аргумент «${name}»`);
    }
    values.set(name, value);
  }
  const file = values.get('--file');
  const month = values.get('--month');
  if (!file || !month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Нужны --file <xlsx> и --month YYYY-MM');
  return {
    file,
    month,
    overrides: values.get('--overrides') ?? null,
    outDir: values.get('--out-dir') ?? os.homedir(),
    envFile: values.get('--env-file') ?? path.join(os.homedir(), '.config', 'mcp', 'env'),
  };
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
  // Только при NODE_ENV=test env.ts не перетирает эти переменные значениями fot-server/.env.
  process.env.NODE_ENV = 'test';
};

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rub = (cents: number): string => (cents / 100)
  .toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  .replace(/ /g, ' ');
const ruDate = (iso: string | null): string => (iso ? iso.split('-').reverse().join('.') : '');

interface IOverrideRule { key: string; employee_id: number | null; name_mismatch?: boolean; note?: string }

const readOverrides = (file: string): IOverrideRule[] => {
  const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rules = (data as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) throw new Error(`${file}: нужен объект { "rules": [...] }`);
  return rules.map((rule: unknown, index): IOverrideRule => {
    const where = `${file}: правило ${index + 1}`;
    if (typeof rule !== 'object' || rule === null) throw new Error(`${where}: не объект`);
    const extra = Object.keys(rule).filter(key => !['key', 'employee_id', 'name_mismatch', 'note'].includes(key));
    if (extra.length > 0) throw new Error(`${where}: лишние поля ${extra.join(', ')}`);
    const { key, employee_id: employeeId, name_mismatch: nameMismatch, note } = rule as Record<string, unknown>;
    if (typeof key !== 'string' || !key.includes('|')) throw new Error(`${where}: key «Регистратор|№» или «ФИО|Подразделение»`);
    if (employeeId !== null && !(typeof employeeId === 'number' && Number.isInteger(employeeId) && employeeId > 0)) {
      throw new Error(`${where}: employee_id — целое > 0 или null`);
    }
    if (nameMismatch !== undefined && typeof nameMismatch !== 'boolean') throw new Error(`${where}: name_mismatch — true/false`);
    if (note !== undefined && typeof note !== 'string') throw new Error(`${where}: note — строка`);
    return { key: key.trim(), employee_id: employeeId, name_mismatch: nameMismatch, note };
  });
};

const pairKeyOf = (fullName: string, department: string | null): string => (
  `${normalizePayoutName(fullName)}|${(department ?? '').trim()}`
);

interface IPair {
  key: string;
  fullName: string;
  department: string | null;
  entries: Array<{ doc: IRegisterDocument; line: IRegisterLine }>;
}

type DecisionKind = 'single' | 'brigade' | 'department' | 'worked' | 'override' | 'ambiguous' | 'none';

const DECISION_LABELS: ReadonlyArray<[DecisionKind, string]> = [
  ['single', 'один кандидат'],
  ['brigade', 'тёзка по бригаде'],
  ['department', 'тёзка по отделу табеля'],
  ['worked', 'тёзка — работал в месяце'],
  ['override', 'решение пользователя'],
  ['ambiguous', 'тёзки — без сотрудника'],
  ['none', 'нет в ФОТ — без сотрудника'],
];

interface IDecision { employeeId: number | null; kind: DecisionKind; reason: string }

const sameName = (a: string | null, b: string | null): boolean => (
  a !== null && b !== null && normalizePayoutName(a) === normalizePayoutName(b)
);

/** Сотрудник пары по кандидатам: один — он; несколько — сужаем бригадой, отделом табеля, «работал в месяце». */
const decide = (pair: IPair, candidates: readonly IPayoutCandidate[], prefix: string): IDecision => {
  if (candidates.length === 0) return { employeeId: null, kind: 'none', reason: `${prefix}: нет в ФОТ` };
  if (candidates.length === 1) {
    return { employeeId: candidates[0].employee_id, kind: 'single', reason: `${prefix}: ФИО + подразделение` };
  }
  const stages: Array<[DecisionKind, string, (c: IPayoutCandidate) => boolean]> = [
    ['brigade', 'тёзка — по бригаде', c => c.brigade_match],
    ['department', 'тёзка — по отделу табеля', c => sameName(c.department, pair.department)],
    ['worked', 'тёзка — работал в месяце', c => c.worked_in_month],
  ];
  let pool = [...candidates];
  for (const [kind, text, keep] of stages) {
    const next = pool.filter(keep);
    if (next.length === 1) return { employeeId: next[0].employee_id, kind, reason: `${prefix}: ${text}` };
    if (next.length > 1) pool = next;
  }
  return {
    employeeId: null,
    kind: 'ambiguous',
    reason: `${prefix}: несколько в ФОТ (${pool.map(c => c.employee_id).join(', ')})`,
  };
};

const writePrivate = (file: string, content: string | Buffer): void => {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  loadReadonlyEnv(args.envFile);
  const { query, closeDb } = await import('../src/config/postgres.js');
  const { loadPayoutEligibility, matchPayoutLines, SQL_NAME } = await import('../src/services/payroll/payroll-1c-payouts.matching.js');
  const { payoutNumberLockKey } = await import('../src/services/payroll/payroll-1c-payouts.service.js');
  try {
    const [role] = await query<{ who: string; can_insert: boolean }>(
      `SELECT current_user AS who, has_table_privilege('public.payroll_1c_payout_documents', 'INSERT') AS can_insert`,
    );
    if (role?.who !== 'mcp_readonly' || role.can_insert) {
      throw new Error(`Нужна read-only роль mcp_readonly без права записи, а подключено: ${role?.who ?? '?'}`);
    }

    const workbook = XLSX.read(fs.readFileSync(args.file), { type: 'buffer' });
    if (workbook.SheetNames.length !== 1) throw new Error(`В файле ${workbook.SheetNames.length} листов, ожидался один`);
    const sheet = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], {
      header: 1, raw: true, defval: null,
    });
    const documents = buildRegisterDocuments(sheet, args.month);
    const periodMonth = `${args.month}-01`;
    const prefix = `Регистр выплат ЗУП ${args.month.slice(5)}.${args.month.slice(0, 4)}`;

    const pairs = new Map<string, IPair>();
    for (const doc of documents) {
      for (const line of doc.lines) {
        const key = pairKeyOf(line.fullName, line.department);
        const pair = pairs.get(key) ?? { key, fullName: line.fullName, department: line.department, entries: [] };
        pair.entries.push({ doc, line });
        pairs.set(key, pair);
      }
    }
    const matches = await matchPayoutLines({
      periodMonth,
      lines: [...pairs.values()].map((pair, index) => ({
        lineNo: index + 1, fullName: pair.fullName, personIdAll: null, brigade: pair.department, amountCents: 0, lineKey: pair.key,
      })),
    });
    const candidatesOf = (pair: IPair): IPayoutCandidate[] => matches.get(pair.key)?.candidates ?? [];
    const decisions = new Map([...pairs.values()].map(pair => [pair.key, decide(pair, candidatesOf(pair), prefix)]));

    // Решения пользователя: строка ведомости точнее пары «ФИО|подразделение».
    const rules = args.overrides ? readOverrides(args.overrides) : [];
    const rowRules = new Map<string, IOverrideRule>();
    const pairRules = new Map<string, IOverrideRule>();
    for (const rule of rules) {
      const row = ROW_KEY_RE.exec(rule.key);
      const separator = rule.key.indexOf('|');
      const key = row ? `${row[1]}|${row[2]}` : pairKeyOf(rule.key.slice(0, separator), rule.key.slice(separator + 1));
      const target = row ? rowRules : pairRules;
      if (target.has(key)) throw new Error(`Правило «${rule.key}» повторяется`);
      target.set(key, rule);
    }
    const mismatchIds = rules
      .filter(rule => rule.name_mismatch)
      .map(rule => rule.employee_id)
      .filter((id): id is number => id !== null);
    const mismatchInfo = await loadPayoutEligibility(mismatchIds, periodMonth);
    const used = new Set<IOverrideRule>();
    const lineDecision = new Map<IRegisterLine, IDecision>();
    const decisionOf = (line: IRegisterLine): IDecision => {
      const decision = lineDecision.get(line);
      if (!decision) throw new Error(`Строка без решения: ${line.fullName}`);
      return decision;
    };
    const pairDecisionOf = (pair: IPair): IDecision => {
      const decision = decisions.get(pair.key);
      if (!decision) throw new Error(`Пара без решения: ${pair.fullName}`);
      return decision;
    };
    for (const pair of pairs.values()) {
      for (const { doc, line } of pair.entries) {
        const rowHits = [...new Set(line.sourceRows.map(no => rowRules.get(`${doc.registrar}|${no}`)).filter(
          (rule): rule is IOverrideRule => rule !== undefined,
        ))];
        const pairRule = pairRules.get(pair.key);
        const hits = [...rowHits, ...(pairRule ? [pairRule] : [])];
        hits.forEach(rule => used.add(rule));
        if (new Set(hits.map(rule => rule.employee_id)).size > 1) {
          throw new Error(`Правила противоречат друг другу: ${hits.map(rule => rule.key).join(' / ')}`);
        }
        const rule = hits[0];
        if (!rule) {
          lineDecision.set(line, pairDecisionOf(pair));
          continue;
        }
        if (rule.employee_id !== null) {
          const isCandidate = candidatesOf(pair).some(c => c.employee_id === rule.employee_id);
          const info = mismatchInfo.get(rule.employee_id);
          if (!isCandidate && !(rule.name_mismatch && info)) {
            throw new Error(`Правило «${rule.key}»: id ${rule.employee_id} не кандидат (другое ФИО — только с name_mismatch)`);
          }
          if (!isCandidate && info && !info.eligible) {
            throw new Error(`Правило «${rule.key}»: id ${rule.employee_id} в месяце у подрядчика`);
          }
        }
        lineDecision.set(line, {
          employeeId: rule.employee_id,
          kind: 'override',
          reason: `${prefix}: решение пользователя${rule.employee_id === null ? ' — без сотрудника' : ''}`,
        });
      }
    }
    const unused = rules.filter(rule => !used.has(rule));
    if (unused.length > 0) throw new Error(`Правила не сработали: ${unused.map(rule => rule.key).join('; ')}`);

    // Итоговые сотрудники: ФИО для проверки при запуске, отдел месяца, увольнение; подрядчик — ошибка.
    const finalIds = [...new Set([...lineDecision.values()].map(d => d.employeeId).filter((id): id is number => id !== null))];
    const info = await loadPayoutEligibility(finalIds, periodMonth);
    for (const id of finalIds) {
      const employee = info.get(id);
      if (!employee) throw new Error(`Сотрудник ${id} не найден`);
      if (!employee.eligible) throw new Error(`Сотрудник ${id} в месяце у подрядчика`);
    }

    const sqlLines: IRegisterSqlLine[] = documents.flatMap(doc => doc.lines.map(line => {
      const decision = decisionOf(line);
      const employee = decision.employeeId === null ? null : info.get(decision.employeeId);
      return {
        guid: doc.guid,
        lineNo: line.lineNo,
        lineKey: line.lineKey,
        fullName: line.fullName,
        department: line.department,
        amountCents: line.amountCents,
        employeeId: decision.employeeId,
        employeeName: employee?.full_name ?? null,
        resolution: decision.employeeId === null ? 'unmatched' : 'confirmed',
        reason: decision.reason,
      };
    }));
    for (const line of sqlLines) {
      if (line.fullName.length > 300 || (line.department ?? '').length > 300 || line.reason.length > 300) {
        throw new Error(`Слишком длинное поле строки: ${line.fullName}`);
      }
    }

    // Не найдены: есть ли тёзки у подрядчика — подсказка для решения.
    const nonePairs = [...pairs.values()].filter(pair => pairDecisionOf(pair).kind === 'none');
    const nameRows = nonePairs.length === 0 ? [] : await query<{ id: number; name_key: string }>(
      `SELECT id, ${SQL_NAME('full_name')} AS name_key FROM employees WHERE ${SQL_NAME('full_name')} = ANY($1::text[])`,
      [nonePairs.map(pair => normalizePayoutName(pair.fullName))],
    );
    const contractorInfo = await loadPayoutEligibility(nameRows.map(row => Number(row.id)), periodMonth);
    const contractorIdsByName = new Map<string, number[]>();
    for (const row of nameRows) {
      contractorIdsByName.set(row.name_key, [...(contractorIdsByName.get(row.name_key) ?? []), Number(row.id)]);
    }

    // Сверка.
    const methodsOrder = [...new Set(documents.map(doc => doc.paymentMethod))].sort();
    const totalsBy = (lines: readonly IRegisterSqlLine[]) => {
      const sum = new Map<string, number>();
      const guidMethod = new Map(documents.map(doc => [doc.guid, doc.paymentMethod]));
      for (const line of lines) {
        const method = guidMethod.get(line.guid) ?? '?';
        sum.set(method, (sum.get(method) ?? 0) + line.amountCents);
      }
      return sum;
    };
    const matchedLines = sqlLines.filter(line => line.employeeId !== null);
    const unmatchedLines = sqlLines.filter(line => line.employeeId === null);
    const all = totalsBy(sqlLines);
    const matchedBy = totalsBy(matchedLines);
    const unmatchedBy = totalsBy(unmatchedLines);
    const cents = (lines: readonly IRegisterSqlLine[]) => lines.reduce((sum, line) => sum + line.amountCents, 0);
    const totalCents = cents(sqlLines);

    const summary: unknown[][] = [
      ['Способ выплаты', 'Ведомостей', 'Строк', 'Сумма', 'С сотрудником', 'Без сотрудника'],
      ...methodsOrder.map(method => [
        method,
        documents.filter(doc => doc.paymentMethod === method).length,
        documents.filter(doc => doc.paymentMethod === method).reduce((sum, doc) => sum + doc.lines.length, 0),
        (all.get(method) ?? 0) / 100, (matchedBy.get(method) ?? 0) / 100, (unmatchedBy.get(method) ?? 0) / 100,
      ]),
      ['Итого', documents.length, sqlLines.length, totalCents / 100, cents(matchedLines) / 100, cents(unmatchedLines) / 100],
      [],
      ['Сотрудников с выплатой', finalIds.length],
      ['Пар «ФИО + подразделение»', pairs.size],
      ...DECISION_LABELS.map(([kind, label]) => [
        `Строк: ${label}`, [...lineDecision.values()].filter(decision => decision.kind === kind).length,
      ]),
    ];
    const pairCents = (pair: IPair) => pair.entries.reduce((sum, entry) => sum + entry.line.amountCents, 0);
    const pairRows = (pair: IPair) => pair.entries.map(entry => `${entry.doc.registrar}|${entry.line.sourceRows.join(',')}`).join('; ');
    const candidateText = (list: readonly IPayoutCandidate[]) => list.map(c => (
      `${c.employee_id} ${c.full_name} — ${c.department ?? 'без отдела'}${c.worked_in_month ? '' : ', не работал в месяце'}`
      + `${c.brigade_match ? ', бригада совпала' : ''}`
    )).join('\n');
    const finalOf = (pair: IPair) => [...new Set(pair.entries.map(entry => decisionOf(entry.line).employeeId))];

    const notFound: unknown[][] = [['ФИО', 'Подразделение 1С', 'Сумма', 'В ФОТ', 'Ключ решения', 'Строки ведомостей']];
    const namesakes: unknown[][] = [['ФИО', 'Подразделение 1С', 'Сумма', 'Кандидаты (id ФИО — отдел месяца)', 'Ключ решения', 'Строки ведомостей']];
    const review: unknown[][] = [['ФИО', 'Подразделение 1С', 'id', 'ФИО в ФОТ', 'Отдел в месяце', 'Что проверить']];
    const everyone: unknown[][] = [[
      'ФИО', 'Подразделение 1С', 'id', 'ФИО в ФОТ', 'Отдел в месяце', 'Сопоставление', ...methodsOrder, 'Итого',
    ]];
    const idsByName = new Map<string, Set<number>>();
    for (const pair of [...pairs.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'))) {
      const decision = pairDecisionOf(pair);
      const finals = finalOf(pair);
      const overridden = pair.entries.some(entry => decisionOf(entry.line).kind === 'override');
      if (decision.kind === 'none' && !overridden) {
        const ids = contractorIdsByName.get(normalizePayoutName(pair.fullName)) ?? [];
        const where = ids.map(id => `${id} ${contractorInfo.get(id)?.full_name ?? ''} — ${contractorInfo.get(id)?.department ?? ''}`
          + `${contractorInfo.get(id)?.eligible === false ? ' (подрядчик в месяце)' : ''}`).join('\n');
        notFound.push([pair.fullName, pair.department, pairCents(pair) / 100, where || 'нет', `${pair.fullName}|${pair.department ?? ''}`, pairRows(pair)]);
      }
      if (decision.kind === 'ambiguous' && !overridden) {
        namesakes.push([
          pair.fullName, pair.department, pairCents(pair) / 100, candidateText(candidatesOf(pair)),
          `${pair.fullName}|${pair.department ?? ''}`, pairRows(pair),
        ]);
      }
      for (const id of finals) {
        if (id === null) continue;
        const employee = info.get(id);
        const candidate = candidatesOf(pair).find(c => c.employee_id === id);
        const notes: string[] = [];
        if (['brigade', 'department', 'worked'].includes(decision.kind)) {
          notes.push(`${decision.reason.replace(`${prefix}: `, '')}; кандидаты:\n${candidateText(candidatesOf(pair))}`);
        }
        if (employee?.dismissal_date && employee.dismissal_date < periodMonth) {
          notes.push(`уволен в ФОТ ${ruDate(employee.dismissal_date)} — до начала месяца`);
        }
        if (decision.kind === 'single' && candidate && !candidate.brigade_match && !sameName(candidate.department, pair.department)) {
          notes.push(`отдел в ФОТ «${candidate.department ?? '—'}» ≠ подразделение 1С`);
        }
        if (!candidate) notes.push('решение пользователя: ФИО в ФОТ другое');
        if (notes.length > 0) review.push([pair.fullName, pair.department, id, employee?.full_name, employee?.department, notes.join('; ')]);
        const name = normalizePayoutName(pair.fullName);
        idsByName.set(name, new Set([...(idsByName.get(name) ?? []), id]));
      }
      for (const id of finals) {
        const entries = pair.entries.filter(entry => decisionOf(entry.line).employeeId === id);
        const byMethod = new Map<string, number>();
        for (const entry of entries) byMethod.set(entry.doc.paymentMethod, (byMethod.get(entry.doc.paymentMethod) ?? 0) + entry.line.amountCents);
        const employee = id === null ? null : info.get(id);
        const kinds = [...new Set(entries.map(entry => decisionOf(entry.line).reason.replace(`${prefix}: `, '')))];
        everyone.push([
          pair.fullName, pair.department, id, employee?.full_name ?? null, employee?.department ?? null, kinds.join('; '),
          ...methodsOrder.map(method => {
            const sum = byMethod.get(method);
            return sum === undefined ? null : sum / 100;
          }),
          entries.reduce((sum, entry) => sum + entry.line.amountCents, 0) / 100,
        ]);
      }
    }
    for (const [name, ids] of idsByName) {
      if (ids.size > 1) review.push([name, null, [...ids].join(', '), null, null, 'одно ФИО → разные сотрудники ФОТ']);
    }

    const book = XLSX.utils.book_new();
    const addSheet = (title: string, rows: unknown[][], widths: number[]) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = widths.map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(book, ws, title);
    };
    addSheet('Итоги', summary, [46, 12, 10, 18, 18, 18]);
    addSheet('Не найдены', notFound, [40, 30, 14, 50, 60, 60]);
    addSheet('Тёзки', namesakes, [40, 30, 14, 70, 60, 60]);
    addSheet('Проверить', review, [40, 30, 8, 40, 36, 70]);
    addSheet('Все', everyone, [40, 30, 8, 40, 36, 40, ...methodsOrder.map(() => 14), 16]);

    const base = path.join(args.outDir, `payroll-1c-payouts-${args.month}`);
    const files = {
      sql: `${base}.sql`,
      rollback: `${base}-rollback.sql`,
      report: path.join(args.outDir, `Перечислено_1С_${args.month}_сверка.xlsx`),
      manifest: `${base}.manifest.json`,
    };
    const sourceSha = sha256(args.file);
    const overridesSha = args.overrides ? sha256(args.overrides) : null;
    const gitHead = execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim();
    const collapsed = documents.flatMap(doc => doc.lines).filter(line => line.sourceRows.length > 1).length;
    const methodLine = methodsOrder.map(method => `${method} ${rub(all.get(method) ?? 0)}`).join(' · ');
    const header = [
      `Зарплата → «Перечислено (1С)»: выплаты за ${args.month.slice(5)}.${args.month.slice(0, 4)} из регистра выплат ЗУП`,
      `(«${path.basename(args.file)}», sha256 ${sourceSha}).`,
      `Ведомостей ${documents.length}, строк ${sqlLines.length} (свёрнуто зачётов ${collapsed}), итог ${rub(totalCents)}.`,
      `По способам: ${methodLine}.`,
      `С сотрудником: строк ${matchedLines.length} на ${rub(cents(matchedLines))}, сотрудников ${finalIds.length};`
        + ` без сотрудника: строк ${unmatchedLines.length} на ${rub(cents(unmatchedLines))}.`,
      `Решения пользователя: ${args.overrides ? `${rules.length} правил («${path.basename(args.overrides)}», sha256 ${overridesSha})` : 'нет'}.`,
      `Сверка: ${path.basename(files.report)}; manifest: ${path.basename(files.manifest)}.`,
      '',
      'Журнал payroll_1c_payout_imports не пишется: это первичная загрузка (seed), source_format допускает только',
      'zup2/external. Происхождение — resolution_reason каждой строки и manifest.',
      'ГУИД ведомости — UUID v5 от «номер|дата» (payroll-1c-payouts.register.ts); XML той же ведомости кнопкой',
      '«Загрузить из 1С» не загрузится (409 по номеру и дате).',
      'Состояния: ведомостей нет → вставка; ровно этот набор (revision 1, строки, журнал пуст) → без изменений;',
      'иначе → откат, ничего не записано.',
      `Запуск: psql -X -v ON_ERROR_STOP=1 -f ${path.basename(files.sql)} → NOTICE «Вставлено ведомостей: ${documents.length}…».`,
      `Откат (только по решению): ${path.basename(files.rollback)}.`,
      `Собрано ${new Date().toISOString()} из ${gitHead} (scripts/build-payouts-register-sql.ts).`,
    ];
    const input = {
      header,
      documents: documents.map(doc => ({
        guid: doc.guid, docNumber: doc.docNumber, docDate: doc.docDate, periodMonth: doc.periodMonth,
        paymentMethod: doc.paymentMethod, totalCents: doc.totalCents, contentHash: doc.contentHash,
        lineCount: doc.lines.length, lockKey: payoutNumberLockKey(doc.docNumber, doc.docDate),
      })),
      lines: sqlLines,
    };
    writePrivate(files.sql, buildRegisterLoadSql(input));
    writePrivate(files.rollback, buildRegisterRollbackSql({ ...input, header: [...header.slice(0, 2), 'ОТКАТ: удаляет все ведомости набора, только если их не меняли после загрузки.'] }));
    writePrivate(files.report, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    writePrivate(files.manifest, `${JSON.stringify({
      generated_at: new Date().toISOString(),
      git_head: gitHead,
      month: args.month,
      source: { file: path.basename(args.file), sha256: sourceSha },
      overrides: args.overrides ? { file: path.basename(args.overrides), sha256: overridesSha, rules: rules.length } : null,
      counts: {
        documents: documents.length, lines: sqlLines.length, total: (totalCents / 100).toFixed(2),
        matched_lines: matchedLines.length, unmatched_lines: unmatchedLines.length, employees: finalIds.length,
        not_found: notFound.length - 1, namesakes: namesakes.length - 1, review: review.length - 1,
      },
      outputs: {
        sql: { file: path.basename(files.sql), sha256: sha256(files.sql) },
        rollback: { file: path.basename(files.rollback), sha256: sha256(files.rollback) },
        report: { file: path.basename(files.report), sha256: sha256(files.report) },
      },
    }, null, 2)}\n`);

    console.log(`${TAG} ведомостей ${documents.length}, строк ${sqlLines.length}, итог ${rub(totalCents)}`);
    console.log(`${TAG} с сотрудником: строк ${matchedLines.length} (${rub(cents(matchedLines))}), сотрудников ${finalIds.length}`);
    console.log(`${TAG} без сотрудника: строк ${unmatchedLines.length} (${rub(cents(unmatchedLines))});`
      + ` не найдены ${notFound.length - 1}, тёзки ${namesakes.length - 1}, проверить ${review.length - 1}`);
    for (const file of Object.values(files)) console.log(`${TAG} ${file}`);
  } finally {
    await closeDb();
  }
};

main().catch(err => {
  console.error(`${TAG} ОШИБКА: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
