/**
 * Выгрузка ведомостей выплаты ЗУП2 за месяц (XML «выплаченная ЗП за …», много документов) → SQL загрузки в
 * «Перечислено (1С)» (миграция 328), SQL отката, сверка xlsx и manifest. Решение пользователя 06.11.2026: октябрь —
 * разовым скриптом, как сентябрь; ведомости «Премии» не загружаются (--skip-method Премии).
 *
 * Разбор — payroll-1c-payouts.month-xml.ts (руководство один раз, ключи и хеш — как у кнопки «Загрузить из 1С»).
 * Сотрудник — по физлицу (ФИО + id_all), кандидаты — matchPayoutLines (подрядчик в месяце не кандидат):
 * авто по id_all → один кандидат по ФИО → тёзки: «работал в месяце» (по датам приёма и увольнения; уволенный без даты
 * увольнения — не работал) → ранее подтверждён под этим ФИО в «Перечислено (1С)» → иначе без сотрудника (лист «Тёзки»).
 * Нет в ФОТ — без сотрудника (лист «Не найдены»).
 *
 * Догрузка: ведомости, уже лежащие в БД с тем же ГУИДом и хешем, пропускаются; тот же ГУИД с другим содержимым или
 * тот же номер с датой под другим ГУИДом — ошибка.
 *
 * --replace-method <вид> (решение пользователя 10.11.2026: премии сентября — все из XML): ведомости этого вида за месяц
 * заменяются ведомостями файла этого вида, остальные документы месяца не трогаются, другие виды файла не грузятся.
 * Месяц на проде читается одним снимком (payouts-register-replace.ts) и обязан быть в форме загрузки регистром;
 * SQL — buildRegisterReplaceSql (откат — обратная замена). Сотрудник строки файла обязан совпасть с тем, кому в этом
 * месяце уже сопоставлено то же ФИО, иначе — стоп.
 *
 * Несколько файлов (--file повторяемый, решение 17.11.2026 — сентябрь СМ, 8 выгрузок) — один набор, правила набора и
 * сверка с БД — scripts/lib/payouts-xml-files.ts. Организация — СУ-10 или СМ (миграция 366), одна на запуск.
 *
 * --move-doc <номер> (повторяемый): ведомость, которую 1С провела другим месяцем, грузится в --month (решение
 * пользователя: премии СМ от 30.10 и 16.11 — за сентябрь). Хеш — по исходному документу 1С; в причине строк — маркер
 * переноса (moveMarker), шесть ведомостей — в шапке SQL, КОНТРОЛЕ, xlsx и manifest. Выгрузка своего месяца потом
 * увидит её как «уже перенесена» и пропустит.
 *
 * --link «ФИО=id» и --unmatched «ФИО» — ручные решения пользователя по физлицу (applyManualRules: ровно одно физлицо
 * под ФИО, правило использовано, код 1С не ведёт к другой карточке).
 *
 * Выгрузка ЗУП2 «ЗП к выплате» (корень ЗУП_ВЫПЛАТЫ, `<имя>данные_из_зуп_зп_к_выплате</имя>`, решение пользователя
 * 18.11.2026 — октябрь, документ 0000000403): вида выплаты и ИНН в файле нет — --payment-method и --organization-inn
 * обязательны; сотрудник — только по коду физлица 1С (decideByIdAll), ФИО не используется; --move-doc, --link,
 * --unmatched, --skip-method, --replace-method не принимаются (payouts-xml-args.ts). Сумма — зарплата и премия вместе,
 * поэтому стоп, если у её сотрудников (или их кодов 1С) в месяце уже есть строки этого вида, «Зарплаты за месяц» или
 * «Премий»; выгрузка ведомостей ЗУП в такой месяц предупреждает о строках «ЗП к выплате» у своих сотрудников.
 *
 * Работает на read-only проде (роль mcp_readonly из --env-file) и в базу ничего не пишет. Файлы — в --out-dir,
 * права 600, не в git (ФИО и суммы); имена — с --tag; существующий файл не перезаписывается. Исходники с
 * незакоммиченными правками — отказ: SQL и manifest подписаны HEAD.
 * SQL — с открытой транзакцией: \i в интерактивном psql, сверка КОНТРОЛЯ, затем COMMIT; или ROLLBACK;.
 *
 * Запуск:
 *   cd fot-server && TZ=UTC npx tsx scripts/build-payouts-xml-sql.ts --file <xml> [--file <xml> …] --month 2026-10 \
 *     [--tag sm] [--move-doc <номер> …] [--link "ФИО=id" …] [--unmatched "ФИО" …] \
 *     [--skip-method Премии | --replace-method Премии] [--out-dir ~] [--env-file ~/.config/mcp/env] [--database FOT_Prod]
 *   «ЗП к выплате»: … --file <xml> --month 2026-10 --tag zp-k-vyplate --payment-method "Зарплата за месяц" \
 *     --organization-inn 7736255508
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

import type { IPayoutCandidate } from '../src/services/payroll/payroll-1c-payouts.matching.js';
import {
  normalizePayoutName,
  PAYOUT_LINE_MONTH_SQL,
  SM_ORGANIZATION_INN,
  type IPayout1cLine,
} from '../src/services/payroll/payroll-1c-payouts.parser.js';
import {
  applyManualRules,
  decide,
  decideByIdAll,
  DECISION_LABELS,
  parseManualRules,
  type DecisionKind,
  type IDecision,
} from './lib/payouts-person-decision.js';
import { buildReplaceTarget, loadMonthSnapshot, snapshotToInput } from './lib/payouts-register-replace.js';
import {
  buildRegisterLoadSql,
  buildRegisterReplaceSql,
  buildRegisterRollbackSql,
  type IRegisterSqlDocument,
  type IRegisterSqlInput,
  type IRegisterSqlLine,
} from './lib/payouts-register-sql.js';
import {
  buildXmlSqlLines,
  classifyStored,
  monthLabelOf,
  MOVE_MARK,
  outputNames,
  parseXmlFiles,
  TO_PAY_REASON_PREFIX,
  type IStoredPayoutDoc,
  type IXmlSetDocument,
} from './lib/payouts-xml-files.js';
import { assertArgsForKind, parseXmlSqlArgs } from './lib/payouts-xml-args.js';

const TAG = '[build-payouts-xml-sql]';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Исходники, от которых зависит результат: с незакоммиченными правками генератор не работает. */
const SOURCE_PATHS = [
  'fot-server/scripts/build-payouts-xml-sql.ts',
  'fot-server/scripts/lib/payouts-register-sql.ts',
  'fot-server/scripts/lib/payouts-register-replace.ts',
  'fot-server/scripts/lib/payouts-person-decision.ts',
  'fot-server/scripts/lib/payouts-xml-files.ts',
  'fot-server/scripts/lib/payouts-xml-args.ts',
  'fot-server/src/services/payroll/payroll-1c-payouts.month-xml.ts',
  'fot-server/src/services/payroll/payroll-1c-payouts.to-pay-xml.ts',
  'fot-server/src/services/payroll/payroll-1c-payouts.parser.ts',
  'fot-server/src/services/payroll/payroll-1c-payouts.matching.ts',
  'fot-server/src/services/payroll/payroll-1c-payouts.service.ts',
  'fot-server/src/services/payroll/payroll-month-attribution.service.ts',
  'fot-server/src/services/payroll/payroll-summary.attribution.ts',
  'fot-server/src/config/postgres.ts',
  'fot-server/src/config/env.ts',
];

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
const writePrivate = (file: string, content: string | Buffer): void => {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};
const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const TRANSLIT: Readonly<Record<string, string>> = Object.fromEntries(
  [...'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'].map((ch, index) => [ch, [
    'a', 'b', 'v', 'g', 'd', 'e', 'e', 'zh', 'z', 'i', 'i', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'h', 'c', 'ch',
    'sh', 'sch', '', 'y', '', 'e', 'yu', 'ya',
  ][index]]),
);

/** Физлицо файла: нормализованное ФИО + id_all. */
interface IPerson {
  key: string;
  fullName: string;
  idAll: string | null;
  entries: Array<{ doc: IXmlSetDocument; line: IPayout1cLine }>;
}


interface ITotals { docs: number; lines: number; cents: number }

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const result = new Map<string, T[]>();
  for (const item of items) result.set(keyOf(item), [...(result.get(keyOf(item)) ?? []), item]);
  return result;
};

interface IMonthTotals { docs: number; lines: number; total: string; lines_emp: number; total_emp: string; lines_none: number; total_none: string }

const main = async (): Promise<void> => {
  const args = parseXmlSqlArgs(process.argv.slice(2), os.homedir());
  const gitHead = sourceHead();
  loadReadonlyEnv(args.envFile);
  const { query, closeDb, withReadOnlySnapshot } = await import('../src/config/postgres.js');
  const { loadPayoutEligibility, matchPayoutLines, SQL_NAME } = await import('../src/services/payroll/payroll-1c-payouts.matching.js');
  const { payoutNumberLockKey } = await import('../src/services/payroll/payroll-1c-payouts.service.js');
  try {
    const [role] = await query<{ who: string; can_insert: boolean }>(
      `SELECT current_user AS who, has_table_privilege('public.payroll_1c_payout_documents', 'INSERT') AS can_insert`,
    );
    if (role?.who !== 'mcp_readonly' || role.can_insert) {
      throw new Error(`Нужна read-only роль mcp_readonly без права записи, а подключено: ${role?.who ?? '?'}`);
    }

    const periodMonth = `${args.month}-01`;
    const monthLabel = monthLabelOf(periodMonth);
    const manualRules = parseManualRules(args.links, args.unmatched);
    // Имена результатов — сразу: существующий файл не перезаписывается (прежние загрузки месяца лежат рядом).
    // Вид — латиницей: «-replace» без вида уже занят заменой регистра (build-payouts-register-sql.ts).
    const methodSlug = args.replaceMethod === null ? null : args.replaceMethod.toLowerCase().split('')
      .map(ch => TRANSLIT[ch] ?? (/[a-z0-9]/.test(ch) ? ch : '-')).join('').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const outNames = outputNames(args.month, args.tag, methodSlug, args.replaceMethod);
    const base = path.join(args.outDir, outNames.base);
    const files = {
      sql: `${base}.sql`,
      rollback: `${base}-rollback.sql`,
      report: path.join(args.outDir, outNames.report),
      manifest: `${base}.manifest.json`,
    };
    const existing = Object.values(files).filter(file => fs.existsSync(file));
    if (existing.length > 0) throw new Error(`Результаты уже есть — не перезаписываю (другой --tag или удалить):\n  ${existing.join('\n  ')}`);

    const toPayOptions = args.paymentMethod !== null && args.organizationInn !== null
      ? { paymentMethod: args.paymentMethod, organizationInn: args.organizationInn } : null;
    const set = parseXmlFiles(
      args.files.map(file => ({ path: file, content: fs.readFileSync(file) })), args.month, args.moveDocs, toPayOptions,
    );
    assertArgsForKind(set.kind, args);
    const isToPay = set.kind === 'to_pay';
    const parsed = set.documents;
    const smMark = set.organizationInn === SM_ORGANIZATION_INN ? ' СМ' : '';
    const prefix = isToPay ? `${TO_PAY_REASON_PREFIX}${monthLabel} (XML ЗУП2${smMark})` : `Выплаченная ЗП ${monthLabel} (XML ЗУП${smMark})`;
    const methods = new Set(parsed.map(doc => doc.paymentMethod));
    const unknownSkip = args.skipMethods.filter(method => !methods.has(method));
    if (unknownSkip.length > 0) throw new Error(`--skip-method: в файле нет вида «${unknownSkip.join('», «')}»`);
    const replaceMethod = args.replaceMethod;
    if (replaceMethod !== null && !methods.has(replaceMethod)) throw new Error(`--replace-method: в файле нет вида «${replaceMethod}»`);
    // Не грузятся: --skip-method, а при замене — все виды, кроме заменяемого (они уже в месяце и не трогаются).
    const isSkipped = (doc: IXmlSetDocument): boolean => (
      replaceMethod !== null ? doc.paymentMethod !== replaceMethod : args.skipMethods.includes(doc.paymentMethod)
    );
    const skipped = parsed.filter(isSkipped);
    const wanted = parsed.filter(doc => !isSkipped(doc));
    const skippedMethods = [...new Set(skipped.map(doc => doc.paymentMethod))].sort((a, b) => a.localeCompare(b, 'ru'));

    // Уже в БД: тот же ГУИД, хеш, ИНН и месяц — «уже загружена»; в другом месяце с отметкой переноса — «уже
    // перенесена»; любое другое расхождение — ошибка (classifyStored).
    const stored = await query<IStoredPayoutDoc>(
      `SELECT d.doc_guid::text AS doc_guid, d.doc_number, d.doc_date::text AS doc_date, d.content_hash,
              d.period_month::text AS period_month, d.organization_inn,
              COALESCE(array_agg(COALESCE(l.resolution_reason, '')) FILTER (WHERE l.document_id IS NOT NULL), '{}') AS reasons
         FROM payroll_1c_payout_documents d LEFT JOIN payroll_1c_payout_lines l ON l.document_id = d.id
        WHERE d.doc_guid = ANY($1::uuid[])
           OR (d.doc_number, d.doc_date) IN (SELECT * FROM unnest($2::text[], $3::date[]))
        GROUP BY d.id`,
      [wanted.map(doc => doc.guid), wanted.map(doc => doc.docNumber), wanted.map(doc => doc.docDate)],
    );
    const loaded: IXmlSetDocument[] = [];
    const alreadyMoved: Array<{ doc: IXmlSetDocument; storedMonth: string }> = [];
    const problems: string[] = [];
    for (const doc of wanted) {
      const state = classifyStored(doc, stored);
      if (state.problem) problems.push(state.problem);
      else if (state.status === 'loaded') loaded.push(doc);
      else if (state.status === 'already_moved') alreadyMoved.push({ doc, storedMonth: state.storedMonth as string });
    }
    if (problems.length > 0) throw new Error(`Ведомости в БД не совпадают с файлами:\n${problems.join('\n')}`);
    for (const { doc, storedMonth } of alreadyMoved) {
      console.log(`${TAG} уже перенесена в ${monthLabelOf(storedMonth)}: ${doc.docNumber} от ${ruDate(doc.docDate)} (${doc.sourceFile}) — пропуск`);
    }
    const stay = new Set<IXmlSetDocument>([...loaded, ...alreadyMoved.map(entry => entry.doc)]);
    const documents = wanted.filter(doc => !stay.has(doc));
    if (documents.length === 0) throw new Error('Все ведомости файлов уже загружены — SQL не нужен');
    const movedDocs = documents.filter(doc => doc.sourcePeriodMonth !== null);

    // Физлица и кандидаты.
    const persons = new Map<string, IPerson>();
    for (const doc of documents) {
      for (const line of doc.lines) {
        const key = `${normalizePayoutName(line.fullName)}|${line.personIdAll ?? ''}`;
        const person = persons.get(key) ?? { key, fullName: line.fullName, idAll: line.personIdAll, entries: [] };
        person.entries.push({ doc, line });
        persons.set(key, person);
      }
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
    const earlierOf = (person: IPerson): Set<number> => earlierByName.get(normalizePayoutName(person.fullName)) ?? new Set();
    // Уволенный без даты увольнения (старые карточки) по датам «работал в любом месяце» — для тёзок это не так.
    const candidateIds = [...new Set([...persons.values()].flatMap(person => candidatesOf(person).map(c => c.employee_id)))];
    const firedNoDate = new Set((await query<{ id: number }>(
      `SELECT id FROM employees WHERE id = ANY($1::int[]) AND employment_status = 'fired' AND dismissal_date IS NULL`,
      [candidateIds],
    )).map(row => Number(row.id)));
    const autoIdOf = (person: IPerson): number | null => matches.get(person.key)?.auto_employee_id ?? null;
    // «ЗП к выплате» — только по коду физлица 1С (правило 1С «не нашли — не загрузили»), ФИО не используется.
    // Ведомости ЗУП — автоматика по id_all и ФИО, поверх неё ручные решения пользователя (applyManualRules).
    const decisions = isToPay
      ? new Map([...persons.values()].map(person => [person.key, decideByIdAll(autoIdOf(person))]))
      : applyManualRules([...persons.values()].map(person => ({
        key: person.key, fullName: person.fullName, idAll: person.idAll, autoEmployeeId: autoIdOf(person),
      })), manualRules, new Map([...persons.values()].map(person => [
        person.key, decide(candidatesOf(person), autoIdOf(person), earlierOf(person), firedNoDate),
      ])));
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
    const personByLine = new Map<IPayout1cLine, IPerson>();
    for (const person of persons.values()) for (const { line } of person.entries) personByLine.set(line, person);

    // Дубль выплаты по людям (не по месяцу целиком): «ЗП к выплате» — зарплата и премия одной суммой, поэтому у её
    // сотрудников (и их кодов 1С) в месяце не должно быть строк этого вида, «Зарплаты за месяц» и «Премий» — иначе стоп.
    // Ведомости ЗУП — предупреждение, если у сотрудника в месяце уже есть строки «ЗП к выплате» (та же зарплата могла
    // прийти обеими выгрузками).
    interface IOverlapRow {
      employee_id: number | null; person_id_all: string | null; full_name_1c: string; doc_number: string; doc_date: string;
      payment_method: string; amount: string;
    }
    const setGuids = documents.map(doc => doc.guid);
    const guardMethods = isToPay ? [...new Set([args.paymentMethod as string, 'Зарплата за месяц', 'Премии'])] : [];
    const overlapRows = isToPay
      ? await query<IOverlapRow>(
        `SELECT l.employee_id, l.person_id_all::text AS person_id_all, l.full_name_1c, d.doc_number, d.doc_date::text AS doc_date,
                d.payment_method, l.amount::text AS amount
           FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
          WHERE ${PAYOUT_LINE_MONTH_SQL} = $1::date AND d.payment_method = ANY($2::text[]) AND d.doc_guid <> ALL($5::uuid[])
            AND (l.employee_id = ANY($3::int[]) OR l.person_id_all = ANY($4::uuid[]))
          ORDER BY l.full_name_1c, d.doc_date, d.doc_number`,
        [periodMonth, guardMethods, finalIds,
          [...new Set([...persons.values()].map(person => person.idAll).filter((id): id is string => id !== null))], setGuids],
      )
      : await query<IOverlapRow>(
        `SELECT l.employee_id, l.person_id_all::text AS person_id_all, l.full_name_1c, d.doc_number, d.doc_date::text AS doc_date,
                d.payment_method, l.amount::text AS amount
           FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
          WHERE ${PAYOUT_LINE_MONTH_SQL} = $1::date AND l.employee_id = ANY($2::int[]) AND d.doc_guid <> ALL($4::uuid[])
            AND l.resolution_reason LIKE $3
          ORDER BY l.full_name_1c, d.doc_date, d.doc_number`,
        [periodMonth, finalIds, `${TO_PAY_REASON_PREFIX}%`, setGuids],
      );
    const overlapText = (row: IOverlapRow) => `${row.full_name_1c} (сотрудник ${row.employee_id ?? '—'}): «${row.payment_method}»`
      + ` ${row.doc_number} от ${ruDate(row.doc_date)} — ${row.amount}`;
    if (isToPay && overlapRows.length > 0) {
      throw new Error(`У сотрудников «ЗП к выплате» за ${monthLabel} уже есть строки «${guardMethods.join('», «')}» — возможен дубль,`
        + ` нужна ручная проверка (${overlapRows.length}):\n  ${overlapRows.map(overlapText).join('\n  ')}`);
    }
    for (const row of overlapRows) console.warn(`${TAG} ВНИМАНИЕ: уже есть «${TO_PAY_REASON_PREFIX.trim()}» за ${monthLabel} — ${overlapText(row)}`);
    const guardLine = isToPay
      ? `Проверка дубля пройдена: у ${finalIds.length} сотрудников и их кодов 1С нет строк «${guardMethods.join('», «')}» за ${monthLabel}.`
      : `Строк «${TO_PAY_REASON_PREFIX.trim()}» за ${monthLabel} у сотрудников набора: ${overlapRows.length}`
        + `${overlapRows.length > 0 ? ' — ВНИМАНИЕ: возможен дубль, лист «Уже ЗП к выплате»' : ''}.`;

    const sqlLines: IRegisterSqlLine[] = buildXmlSqlLines(documents, line => {
      const person = personByLine.get(line);
      if (!person) throw new Error(`Строка без физлица: ${line.fullName}`);
      return decisionOf(person);
    }, id => info.get(id)?.full_name ?? null, prefix);
    const sqlDocs: IRegisterSqlDocument[] = documents.map(doc => ({
      guid: doc.guid, docNumber: doc.docNumber, docDate: doc.docDate, periodMonth: doc.periodMonth,
      paymentMethod: doc.paymentMethod, totalCents: doc.totalCents, contentHash: doc.contentHash,
      lineCount: doc.lines.length, lockKey: payoutNumberLockKey(doc.docNumber, doc.docDate), salaryProject: doc.salaryProject,
      organizationInn: doc.organizationInn,
    }));

    // --replace-method: месяц на проде одним снимком; новый набор = документы месяца других видов как есть + файл.
    const replace = replaceMethod === null ? null : await (async () => {
      const snapshot = await withReadOnlySnapshot(client => loadMonthSnapshot(client, periodMonth));
      const from = snapshotToInput(snapshot, periodMonth, payoutNumberLockKey);
      const keptDocs = from.documents.filter(doc => doc.paymentMethod !== replaceMethod);
      const keptGuids = new Set(keptDocs.map(doc => doc.guid));
      // То же ФИО в месяце уже сопоставлено — строка файла обязана получить того же сотрудника.
      const monthDecisions = new Map<string, Set<number | null>>();
      for (const line of from.lines) {
        const key = normalizePayoutName(line.fullName);
        monthDecisions.set(key, new Set([...(monthDecisions.get(key) ?? []), line.employeeId]));
      }
      const conflicts = [...new Set(sqlLines.flatMap(line => {
        const before = monthDecisions.get(normalizePayoutName(line.fullName));
        return before && (before.size !== 1 || !before.has(line.employeeId))
          ? [`${line.fullName}: сотрудник ${line.employeeId ?? '—'}, в месяце — ${[...before].map(id => id ?? '—').join(', ')}`]
          : [];
      }))];
      if (conflicts.length > 0) {
        throw new Error(`Сотрудник не совпал с уже сопоставленным в месяце (${conflicts.length}) — решить до замены:\n  `
          + conflicts.join('\n  '));
      }
      const target = buildReplaceTarget(from, [...keptDocs, ...sqlDocs], [
        ...from.lines.filter(line => keptGuids.has(line.guid)), ...sqlLines,
      ]);
      const removedOther = target.removed.filter(doc => doc.paymentMethod !== replaceMethod);
      if (removedOther.length > 0 || target.added.length !== sqlDocs.length) {
        throw new Error(`Замена задела не те документы: удаляются другого вида ${removedOther.length}, добавляется ${target.added.length}`);
      }
      const removedGuids = new Set(target.removed.map(doc => doc.guid));
      return { from, ...target, removedLines: from.lines.filter(line => removedGuids.has(line.guid)) };
    })();

    // Состояние БД сейчас — для КОНТРОЛЯ после загрузки и после отката.
    const monthTotalsSql = `SELECT count(DISTINCT d.id)::int AS docs, count(l.document_id)::int AS lines,
         COALESCE(sum(l.amount), 0)::text AS total,
         count(l.employee_id)::int AS lines_emp, COALESCE(sum(l.amount) FILTER (WHERE l.employee_id IS NOT NULL), 0)::text AS total_emp,
         (count(l.document_id) - count(l.employee_id))::int AS lines_none,
         COALESCE(sum(l.amount) FILTER (WHERE l.employee_id IS NULL), 0)::text AS total_none
    FROM payroll_1c_payout_documents d LEFT JOIN payroll_1c_payout_lines l ON l.document_id = d.id
   WHERE d.period_month = DATE ${sqlText(periodMonth)}`;
    const [monthBefore] = await query<IMonthTotals>(monthTotalsSql);
    const methodsBefore = await query<{ payment_method: string; docs: number; lines: number; total: string }>(
      `SELECT d.payment_method, count(DISTINCT d.id)::int AS docs, count(*)::int AS lines, sum(l.amount)::text AS total
         FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
        WHERE d.period_month = $1::date GROUP BY 1 ORDER BY 1`,
      [periodMonth],
    );
    const otherSql = `SELECT count(*)::int AS docs, COALESCE(sum(total_amount), 0)::text AS total
    FROM payroll_1c_payout_documents WHERE period_month <> DATE ${sqlText(periodMonth)}`;
    const [other] = await query<{ docs: number; total: string }>(otherSql);
    // По организациям месяца, перенесённые решением пользователя (маркер в причине строк), журнал — для КОНТРОЛЯ.
    const orgSql = `SELECT d.organization_inn, count(DISTINCT d.id)::int AS docs, count(l.document_id)::int AS lines,
         COALESCE(sum(l.amount), 0)::text AS total
    FROM payroll_1c_payout_documents d LEFT JOIN payroll_1c_payout_lines l ON l.document_id = d.id
   WHERE d.period_month = DATE ${sqlText(periodMonth)} GROUP BY 1 ORDER BY 1`;
    const orgsBeforeRows = await query<{ organization_inn: string; docs: number; lines: number; total: string }>(orgSql);
    const movedSql = `SELECT count(DISTINCT d.id)::int AS docs, count(l.document_id)::int AS lines, COALESCE(sum(l.amount), 0)::text AS total
    FROM payroll_1c_payout_documents d JOIN payroll_1c_payout_lines l ON l.document_id = d.id
   WHERE d.period_month = DATE ${sqlText(periodMonth)} AND l.resolution_reason LIKE '%${MOVE_MARK}%'`;
    const [movedBeforeRow] = await query<{ docs: number; lines: number; total: string }>(movedSql);
    const journalSql = 'SELECT count(*)::int AS records FROM payroll_1c_payout_imports';
    const [journal] = await query<{ records: number }>(journalSql);

    const centsOf = (value: string): number => Math.round(Number(value) * 100);
    const cents = (lines: readonly IRegisterSqlLine[]) => lines.reduce((sum, line) => sum + line.amountCents, 0);
    const matchedLines = sqlLines.filter(line => line.employeeId !== null);
    const unmatchedLines = sqlLines.filter(line => line.employeeId === null);
    const totalCents = cents(sqlLines);
    /** Итоги месяца, если его документы — ровно этот набор. */
    const totalsOfSet = (input: IRegisterSqlInput): IMonthTotals => {
      const withEmployee = input.lines.filter(line => line.employeeId !== null);
      const withoutEmployee = input.lines.filter(line => line.employeeId === null);
      return {
        docs: input.documents.length, lines: input.lines.length, total: num(cents(input.lines)),
        lines_emp: withEmployee.length, total_emp: num(cents(withEmployee)),
        lines_none: withoutEmployee.length, total_none: num(cents(withoutEmployee)),
      };
    };
    const methodsOfSet = (input: IRegisterSqlInput): Map<string, { docs: number; lines: number; cents: number }> => {
      const result = new Map<string, { docs: number; lines: number; cents: number }>();
      for (const doc of input.documents) {
        const entry = result.get(doc.paymentMethod) ?? { docs: 0, lines: 0, cents: 0 };
        result.set(doc.paymentMethod, { docs: entry.docs + 1, lines: entry.lines + doc.lineCount, cents: entry.cents + doc.totalCents });
      }
      return result;
    };
    if (replace && JSON.stringify(totalsOfSet(replace.from)) !== JSON.stringify(monthBefore)) {
      throw new Error('Итоги месяца в снимке и в отдельном запросе разошлись — на проде пишут в этот месяц, повторить позже');
    }
    const after: IMonthTotals = replace ? totalsOfSet(replace.to) : {
      docs: monthBefore.docs + documents.length,
      lines: monthBefore.lines + sqlLines.length,
      total: num(centsOf(monthBefore.total) + totalCents),
      lines_emp: monthBefore.lines_emp + matchedLines.length,
      total_emp: num(centsOf(monthBefore.total_emp) + cents(matchedLines)),
      lines_none: monthBefore.lines_none + unmatchedLines.length,
      total_none: num(centsOf(monthBefore.total_none) + cents(unmatchedLines)),
    };
    const methodsAfter = replace ? methodsOfSet(replace.to)
      : new Map(methodsBefore.map(row => [row.payment_method, { docs: row.docs, lines: row.lines, cents: centsOf(row.total) }]));
    if (!replace) {
      for (const doc of documents) {
        const entry = methodsAfter.get(doc.paymentMethod) ?? { docs: 0, lines: 0, cents: 0 };
        methodsAfter.set(doc.paymentMethod, { docs: entry.docs + 1, lines: entry.lines + doc.lines.length, cents: entry.cents + doc.totalCents });
      }
    }
    const toTotals = (row: { docs: number; lines: number; total: string }): ITotals => (
      { docs: row.docs, lines: row.lines, cents: centsOf(row.total) });
    const ofLines = (lines: readonly IRegisterSqlLine[]): ITotals => ({ docs: new Set(lines.map(line => line.guid)).size, lines: lines.length, cents: cents(lines) });
    const plus = (a: ITotals, b: ITotals): ITotals => ({ docs: a.docs + b.docs, lines: a.lines + b.lines, cents: a.cents + b.cents });
    const isMovedLine = (line: IRegisterSqlLine): boolean => line.reason.includes(MOVE_MARK);
    const orgsBefore = new Map(orgsBeforeRows.map(row => [row.organization_inn, toTotals(row)]));
    const movedBefore = toTotals(movedBeforeRow);
    const orgsAfter = new Map<string, ITotals>();
    if (replace) {
      const innOf = new Map(replace.to.documents.map(doc => [doc.guid, doc.organizationInn]));
      for (const [inn, lines] of groupBy(replace.to.lines, line => innOf.get(line.guid) ?? '?')) orgsAfter.set(inn, ofLines(lines));
    } else {
      for (const [inn, totals] of orgsBefore) orgsAfter.set(inn, totals);
      orgsAfter.set(set.organizationInn, plus(orgsBefore.get(set.organizationInn) ?? { docs: 0, lines: 0, cents: 0 }, ofLines(sqlLines)));
    }
    const movedAfter = replace ? ofLines(replace.to.lines.filter(isMovedLine)) : plus(movedBefore, ofLines(sqlLines.filter(isMovedLine)));

    // Снимаемые заменой строки по сотрудникам — для контроля людей.
    const removedByEmployee = new Map<number, number>();
    for (const line of replace?.removedLines ?? []) {
      if (line.employeeId !== null) removedByEmployee.set(line.employeeId, (removedByEmployee.get(line.employeeId) ?? 0) + line.amountCents);
    }

    // Примеры для экрана: больше всех получивший, отпуск и увольнение — у сопоставленных.
    const byEmployee = new Map<number, { cents: number; methods: Set<string> }>();
    for (const doc of documents) {
      for (const line of doc.lines) {
        const id = decisionOf(personByLine.get(line) as IPerson).employeeId;
        if (id === null) continue;
        const entry = byEmployee.get(id) ?? { cents: 0, methods: new Set<string>() };
        entry.cents += line.amountCents;
        entry.methods.add(doc.paymentMethod);
        byEmployee.set(id, entry);
      }
    }
    const ranked = [...byEmployee.entries()].sort((a, b) => b[1].cents - a[1].cents || a[0] - b[0]);
    // «ЗП к выплате» — короткий список людей: в КОНТРОЛЕ все.
    const samples = isToPay && byEmployee.size <= 20 ? [...byEmployee.keys()].sort((a, b) => a - b) : [...new Set([
      ranked[0]?.[0],
      ranked.find(([, e]) => e.methods.has('Отпуска'))?.[0],
      ranked.find(([, e]) => e.methods.has('Увольнения'))?.[0],
      // Замена: у кого строка снимается, а новой нет (Сайдиллаев в сентябре).
      [...removedByEmployee.entries()].filter(([id]) => !byEmployee.has(id)).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0],
    ].filter((id): id is number => id !== undefined))];
    const sampleBefore = new Map((samples.length === 0 ? [] : await query<{ employee_id: number; total: string }>(
      `SELECT l.employee_id, sum(l.amount)::text AS total FROM payroll_1c_payout_lines l
         JOIN payroll_1c_payout_documents d ON d.id = l.document_id
        WHERE d.period_month = $1::date AND l.employee_id = ANY($2::int[]) GROUP BY 1`,
      [periodMonth, samples],
    )).map(row => [Number(row.employee_id), Math.round(Number(row.total) * 100)]));
    // ФИО — из сопоставления файла, а у кого строка только снимается заменой — из снимка месяца.
    const removedNames = new Map((replace?.removedLines ?? []).flatMap(line => (
      line.employeeId !== null && line.employeeName !== null ? [[line.employeeId, line.employeeName] as const] : [])));
    const sampleLine = (withNew: boolean) => samples.map(id => `${info.get(id)?.full_name ?? removedNames.get(id) ?? '?'} (${id}) `
      + `${num((sampleBefore.get(id) ?? 0) + (withNew ? (byEmployee.get(id)?.cents ?? 0) - (removedByEmployee.get(id) ?? 0) : 0))}`).join('; ');
    const sampleText = sampleLine(true);

    const monthEcho = (label: string, t: IMonthTotals) => `\\echo 'КОНТРОЛЬ ${label}: док. ${t.docs} / стр. ${t.lines} / ${t.total};`
      + ` с сотрудником ${t.lines_emp} / ${t.total_emp}; без ${t.lines_none} / ${t.total_none}'`;
    const methodRows = (rows: Map<string, { docs: number; lines: number; cents: number }>) => [...rows.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'ru')).map(([m, e]) => `${m} ${e.docs}/${e.lines}/${num(e.cents)}`).join('; ');
    const totalsText = (t: ITotals) => `${t.docs} / ${t.lines} / ${num(t.cents)}`;
    const orgText = (orgs: ReadonlyMap<string, ITotals>) => [...orgs.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([inn, t]) => `${inn} ${totalsText(t)}`).join('; ') || 'нет';
    const controls = (label: string, t: IMonthTotals, byMethod: Map<string, { docs: number; lines: number; cents: number }>,
      people: string, orgs: ReadonlyMap<string, ITotals>, moved: ITotals) => [
      monthEcho(`месяц ${monthLabel} ${label}`, t),
      `${monthTotalsSql};`,
      `\\echo 'КОНТРОЛЬ по видам (док./стр./сумма): ${byMethod.size === 0 ? 'нет' : methodRows(byMethod)}'`,
      `SELECT d.payment_method, count(DISTINCT d.id) AS docs, count(*) AS lines, sum(l.amount)::text AS total
  FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
 WHERE d.period_month = DATE ${sqlText(periodMonth)} GROUP BY 1 ORDER BY 1;`,
      `\\echo 'КОНТРОЛЬ другие месяцы без изменений: док. ${other.docs} / ${other.total}'`,
      `${otherSql};`,
      `\\echo 'КОНТРОЛЬ ${monthLabel} по организациям (ИНН док./стр./сумма): ${orgText(orgs)}'`,
      `${orgSql};`,
      `\\echo 'КОНТРОЛЬ ${monthLabel} перенесено из другого месяца 1С решением пользователя: ${totalsText(moved)}'`,
      `${movedSql};`,
      `\\echo 'КОНТРОЛЬ журнал payroll_1c_payout_imports не изменился: ${journal.records}'`,
      `${journalSql};`,
      ...(samples.length === 0 ? [] : [
        `\\echo 'КОНТРОЛЬ люди за ${monthLabel}: ${people}'`,
        `SELECT e.id, e.full_name, COALESCE(sum(l.amount), 0)::text AS on_card FROM employees e
  LEFT JOIN (payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id AND d.period_month = DATE ${sqlText(periodMonth)})
    ON l.employee_id = e.id
 WHERE e.id IN (${samples.join(', ')}) GROUP BY 1, 2 ORDER BY 2;`,
      ]),
    ];
    const beforeByMethod = new Map(methodsBefore.map(row => [row.payment_method, { docs: row.docs, lines: row.lines, cents: centsOf(row.total) }]));
    const samplesBefore = sampleLine(false);

    // Сверка xlsx.
    const methodsOrder = [...new Set(documents.map(doc => doc.paymentMethod))].sort((a, b) => a.localeCompare(b, 'ru'));
    const guidMethod = new Map(documents.map(doc => [doc.guid, doc.paymentMethod]));
    const sumBy = (lines: readonly IRegisterSqlLine[], method: string) => cents(lines.filter(line => guidMethod.get(line.guid) === method));
    const docsCents = (list: readonly IXmlSetDocument[]) => list.reduce((sum, doc) => sum + doc.totalCents, 0);
    const duplicateCents = documents.reduce((sum, doc) => sum + doc.duplicateCents, 0);
    const kindCount = (kind: DecisionKind) => [...persons.values()].filter(person => decisionOf(person).kind === kind).length;
    const summary: unknown[][] = [
      ['Способ выплаты', 'Ведомостей', 'Строк', 'Сумма', 'С сотрудником', 'Без сотрудника'],
      ...methodsOrder.map(method => [
        method, documents.filter(doc => doc.paymentMethod === method).length,
        documents.filter(doc => doc.paymentMethod === method).reduce((sum, doc) => sum + doc.lines.length, 0),
        sumBy(sqlLines, method) / 100, sumBy(matchedLines, method) / 100, sumBy(unmatchedLines, method) / 100,
      ]),
      ['Итого загружается', documents.length, sqlLines.length, totalCents / 100, cents(matchedLines) / 100, cents(unmatchedLines) / 100],
      [],
      ...skippedMethods.map(method => {
        const list = skipped.filter(doc => doc.paymentMethod === method);
        return [`${replace ? 'Не трогается (уже в месяце)' : 'Не загружается'}: ${method}`, list.length,
          list.reduce((sum, doc) => sum + doc.lines.length, 0), docsCents(list) / 100];
      }),
      ...(replace ? [[`Снимается заменой: ${replaceMethod}`, replace.removed.length, replace.removedLines.length,
        replace.removed.reduce((sum, doc) => sum + doc.totalCents, 0) / 100]] : []),
      ['Уже в БД (пропущены)', loaded.length, loaded.reduce((sum, doc) => sum + doc.lines.length, 0), docsCents(loaded) / 100],
      ['Уже перенесены в другой месяц (пропущены)', alreadyMoved.length,
        alreadyMoved.reduce((sum, entry) => sum + entry.doc.lines.length, 0), docsCents(alreadyMoved.map(entry => entry.doc)) / 100],
      ['Перенесены в этот месяц решением пользователя', movedDocs.length, movedDocs.reduce((sum, doc) => sum + doc.lines.length, 0),
        docsCents(movedDocs) / 100],
      ...movedDocs.map(doc => [`  ${doc.docNumber} от ${ruDate(doc.docDate)}: 1С ${monthLabelOf(doc.sourcePeriodMonth as string)} → ${monthLabel}`,
        1, doc.lines.length, doc.totalCents / 100]),
      ['Повтор руководства «00000» (не строка)', documents.filter(doc => doc.duplicateCents > 0).length, '', duplicateCents / 100],
      [],
      ['Сотрудников с выплатой', finalIds.length],
      ['Физлиц в файлах (ФИО + id_all)', persons.size],
      ...[...manualRules.links.values()].map(rule => [`Решение пользователя: «${rule.fullName}» → сотрудник ${rule.employeeId}`]),
      ...[...manualRules.unmatched.values()].map(rule => [`Решение пользователя: «${rule.fullName}» — без сотрудника`]),
      [],
      ['Файлы', 'Ведомостей', 'SHA-256'],
      ...set.sources.map(source => [source.name, source.documents, source.sha256]),
      ['Организация (ИНН)', set.organizationInn],
      ['Выгрузка', isToPay ? `«ЗП к выплате» ЗУП2: вид «${args.paymentMethod}» и ИНН — решение пользователя, сотрудник — только по id_all`
        : 'ведомости ЗУП за месяц'],
      ['Проверка дубля', guardLine],
      ...DECISION_LABELS.map(([kind, label]) => [`Физлиц: ${label}`, kindCount(kind)]),
    ];

    const namesakeRows = await query<{ id: number; name_key: string }>(
      `SELECT id, ${SQL_NAME('full_name')} AS name_key FROM employees WHERE ${SQL_NAME('full_name')} = ANY($1::text[])`,
      [[...persons.values()].filter(person => ['none', 'manual_none', 'id_all_none'].includes(decisionOf(person).kind))
        .map(person => normalizePayoutName(person.fullName))],
    );
    const namesakeInfo = await loadPayoutEligibility(namesakeRows.map(row => Number(row.id)), periodMonth);
    const personCents = (person: IPerson) => person.entries.reduce((sum, entry) => sum + entry.line.amountCents, 0);
    const personMethods = (person: IPerson) => [...new Set(person.entries.map(entry => entry.doc.paymentMethod))].join(', ');
    const personDocs = (person: IPerson) => person.entries.map(entry => `${entry.doc.docNumber} от ${ruDate(entry.doc.docDate)}`).join('; ');
    const candidateText = (list: readonly IPayoutCandidate[]) => list.map(c => (
      `${c.employee_id} ${c.full_name} — ${c.department ?? 'без отдела'}${c.worked_in_month ? '' : ', не работал в месяце'}`
      + `${firedNoDate.has(c.employee_id) ? ', уволен без даты увольнения' : ''}`
    )).join('\n');

    const notFound: unknown[][] = [['ФИО 1С', 'Сумма', 'Виды', 'В ФОТ под этим ФИО', 'Ведомости', 'Решение']];
    const namesakes: unknown[][] = [['ФИО 1С', 'Сумма', 'Виды', 'Кандидаты (id ФИО — отдел месяца)', 'Ведомости']];
    const review: unknown[][] = [['ФИО 1С', 'id', 'ФИО в ФОТ', 'Отдел в месяце', 'Что проверить']];
    const everyone: unknown[][] = [['ФИО 1С', 'id', 'ФИО в ФОТ', 'Отдел в месяце', 'Сопоставление', ...methodsOrder, 'Итого']];
    const sorted = [...persons.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
    for (const person of sorted) {
      const decision = decisionOf(person);
      const id = decision.employeeId;
      const employee = id === null ? null : info.get(id);
      if (decision.kind === 'none' || decision.kind === 'manual_none' || decision.kind === 'id_all_none') {
        const ids = namesakeRows.filter(row => row.name_key === normalizePayoutName(person.fullName)).map(row => Number(row.id));
        notFound.push([person.fullName, personCents(person) / 100, personMethods(person), ids.map(i => (
          `${i} ${namesakeInfo.get(i)?.full_name ?? ''} — ${namesakeInfo.get(i)?.department ?? ''}`
          + `${namesakeInfo.get(i)?.eligible === false ? ' (подрядчик в месяце)' : ''}`)).join('\n') || 'нет', personDocs(person),
          DECISION_LABELS.find(([k]) => k === decision.kind)?.[1]]);
      }
      if (decision.kind === 'ambiguous') {
        namesakes.push([person.fullName, personCents(person) / 100, personMethods(person), candidateText(candidatesOf(person)), personDocs(person)]);
      }
      if (id !== null) {
        const notes: string[] = [];
        if (decision.kind === 'manual') notes.push('указан при загрузке — решение пользователя');
        if (decision.kind === 'worked' || decision.kind === 'earlier') {
          notes.push(`${DECISION_LABELS.find(([k]) => k === decision.kind)?.[1]}; кандидаты:\n${candidateText(candidatesOf(person))}`);
        }
        const earlier = earlierOf(person);
        if (earlier.size > 0 && !earlier.has(id)) notes.push(`ранее под этим ФИО подтверждён другой: ${[...earlier].join(', ')}`);
        if (employee?.dismissal_date && employee.dismissal_date < periodMonth) notes.push(`уволен в ФОТ ${ruDate(employee.dismissal_date)} — до начала месяца`);
        if (employee && !employee.workedInMonth) notes.push('по датам приёма и увольнения в месяце не работал');
        if (notes.length > 0) review.push([person.fullName, id, employee?.full_name, employee?.department, notes.join('; ')]);
      }
      const byMethod = new Map<string, number>();
      for (const entry of person.entries) byMethod.set(entry.doc.paymentMethod, (byMethod.get(entry.doc.paymentMethod) ?? 0) + entry.line.amountCents);
      everyone.push([
        person.fullName, id, employee?.full_name ?? null, employee?.department ?? null,
        DECISION_LABELS.find(([k]) => k === decision.kind)?.[1],
        ...methodsOrder.map(method => (byMethod.has(method) ? (byMethod.get(method) as number) / 100 : null)),
        personCents(person) / 100,
      ]);
    }
    // Строки набора: откуда (файл, ведомость, месяц 1С) и куда (месяц загрузки, сотрудник, решение).
    const lineRows: unknown[][] = [['Файл', 'Ведомость', 'Дата', 'Вид', 'Месяц 1С', 'Месяц загрузки', 'Перенос', 'ФИО 1С', 'Сумма',
      'id', 'ФИО в ФОТ', 'Сопоставление']];
    for (const doc of documents) {
      for (const line of doc.lines) {
        const decision = decisionOf(personByLine.get(line) as IPerson);
        lineRows.push([doc.sourceFile, doc.docNumber, ruDate(doc.docDate), doc.paymentMethod,
          monthLabelOf(doc.sourcePeriodMonth ?? doc.periodMonth), monthLabelOf(doc.periodMonth),
          doc.sourcePeriodMonth === null ? '' : 'решение пользователя', line.fullName, line.amountCents / 100, decision.employeeId,
          decision.employeeId === null ? null : (info.get(decision.employeeId)?.full_name ?? null),
          DECISION_LABELS.find(([k]) => k === decision.kind)?.[1]]);
      }
    }
    const skippedRows: unknown[][] = [['Номер', 'Дата', 'Вид', 'Строк', 'Сумма'],
      ...skipped.map(doc => [doc.docNumber, ruDate(doc.docDate), doc.paymentMethod, doc.lines.length, doc.totalCents / 100])];

    const book = XLSX.utils.book_new();
    const addSheet = (title: string, rows: unknown[][], widths: number[]) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = widths.map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(book, ws, title);
    };
    addSheet('Итоги', summary, [46, 12, 10, 18, 18, 18]);
    addSheet('Не найдены', notFound, [40, 14, 30, 60, 60, 30]);
    addSheet('Тёзки', namesakes, [40, 14, 30, 70, 60]);
    addSheet('Проверить', review, [40, 8, 40, 36, 80]);
    addSheet('Все', everyone, [40, 8, 40, 36, 36, ...methodsOrder.map(() => 14), 16]);
    addSheet('Не загружено', skippedRows, [14, 12, 30, 8, 16]);
    addSheet('Строки', lineRows, [26, 14, 12, 22, 10, 12, 20, 40, 14, 8, 40, 30]);
    if (!isToPay) {
      addSheet('Уже ЗП к выплате', [['ФИО 1С', 'id', 'Вид', 'Ведомость', 'Дата', 'Сумма'], ...overlapRows.map(row => [
        row.full_name_1c, row.employee_id, row.payment_method, row.doc_number, ruDate(row.doc_date), Number(row.amount)])],
      [40, 8, 22, 14, 12, 16]);
    }

    const removedCents = replace ? replace.removed.reduce((sum, doc) => sum + doc.totalCents, 0) : 0;
    const methodLine = methodsOrder.map(method => `${method} ${rub(sumBy(sqlLines, method))}`).join(' · ');
    const header = [
      `Зарплата → «Перечислено (1С)»: выплаты за ${monthLabel} из выгрузки ${isToPay ? 'ЗУП2 «ЗП к выплате»' : 'ведомостей ЗУП'},`
        + ` ИНН ${set.organizationInn}`,
      `(файлов ${set.sources.length}: ${set.sources.map(source => `«${source.name}»`).join(', ')}).`,
      ...(isToPay ? [
        `Вида выплаты и ИНН в файле нет — решение пользователя: «${args.paymentMethod}», ${set.organizationInn}. Сотрудник — только`
          + ' по коду физлица 1С (id_all); сумма = кНачислению − ндфл сверена, НДФЛ и «к начислению» не сохраняются.',
      ] : []),
      guardLine,
      ...set.sources.map(source => `  ${source.name}: ведомостей ${source.documents}, sha256 ${source.sha256}`),
      `Ведомостей ${documents.length}, строк ${sqlLines.length}, итог ${rub(totalCents)}. По способам: ${methodLine}.`,
      `С сотрудником: строк ${matchedLines.length} на ${rub(cents(matchedLines))}, сотрудников ${finalIds.length};`
        + ` без сотрудника: строк ${unmatchedLines.length} на ${rub(cents(unmatchedLines))}.`,
      ...(replace ? [
        `ЗАМЕНА (решение пользователя): ведомости «${replaceMethod}» за ${monthLabel} в БД (${replace.removed.length} шт.,`
          + ` строк ${replace.removedLines.length}, ${rub(removedCents)}) заменяются ведомостями «${replaceMethod}» этого файла;`,
        `остальные ${replace.kept.length} документов месяца не трогаются. Месяц после замены: док. ${after.docs},`
          + ` строк ${after.lines}, ${rub(centsOf(after.total))}.`,
      ] : []),
      ...skippedMethods.map(method => `${replace ? 'Не трогается (уже в месяце)' : 'Не загружается (решение пользователя)'}: «${method}» —`
        + ` ${skipped.filter(doc => doc.paymentMethod === method).length}`
        + ` ведомостей на ${rub(docsCents(skipped.filter(doc => doc.paymentMethod === method)))}.`),
      ...(movedDocs.length === 0 ? [] : [
        `ПЕРЕНОС (решение пользователя): ${movedDocs.length} ведомостей, которые 1С провела другим месяцем, грузятся в ${monthLabel}`
          + ` (${rub(docsCents(movedDocs))}); хеш — по документу 1С, в причине строк — «${MOVE_MARK}…»:`,
        ...movedDocs.map(doc => `  ${doc.docNumber} от ${ruDate(doc.docDate)} («${doc.sourceFile}»): 1С ${monthLabelOf(doc.sourcePeriodMonth as string)}`
          + ` → ${monthLabel}, строк ${doc.lines.length}, ${rub(doc.totalCents)}`),
      ]),
      ...[...manualRules.links.values()].map(rule => `Решение пользователя: «${rule.fullName}» → сотрудник ${rule.employeeId}.`),
      ...[...manualRules.unmatched.values()].map(rule => `Решение пользователя: «${rule.fullName}» — без сотрудника.`),
      `Повтор руководства «00000» не строка: ${rub(duplicateCents)}. Уже в БД и пропущено: ${loaded.length} ведомостей.`,
      ...alreadyMoved.map(({ doc, storedMonth }) => `Уже перенесена в ${monthLabelOf(storedMonth)} и пропущена: ${doc.docNumber}`
        + ` от ${ruDate(doc.docDate)} («${doc.sourceFile}»).`),
      `Сверка: ${path.basename(files.report)}; manifest: ${path.basename(files.manifest)}.`,
      '',
      'Журнал payroll_1c_payout_imports не пишется (первичная загрузка, как регистр сентября); происхождение — resolution_reason.',
      ...(replace ? [
        'Состояния: документы месяца ровно как сейчас → замена; уже новый набор → без изменений; иначе → ошибка, ничего не записано.',
        `Запуск: psql, затем \\i ${path.basename(files.sql)} → NOTICE «Оставлено документов: ${replace.kept.length},`
          + ` удалено: ${replace.removed.length}, добавлено: ${replace.added.length} (строк ${sqlLines.length})»`,
      ] : [
        'Состояния: ведомостей набора нет → вставка; ровно этот набор (revision 1, строки, журнал пуст) → без изменений;',
        'иначе → ошибка, ничего не записано.',
        `Запуск: psql, затем \\i ${path.basename(files.sql)} → NOTICE «Вставлено ведомостей: ${documents.length}, строк: ${sqlLines.length}»`,
      ]),
      'и КОНТРОЛЬ; транзакция остаётся открытой: COMMIT; если всё верно, ROLLBACK; если нет. После ошибки — ROLLBACK;.',
      `Откат (только по решению): ${path.basename(files.rollback)}.`,
      `Собрано ${new Date().toISOString()} из ${gitHead} (scripts/build-payouts-xml-sql.ts).`,
    ];
    const input: IRegisterSqlInput = { header, documents: sqlDocs, lines: sqlLines };
    const peopleAfter = sampleText;
    if (replace) {
      writePrivate(files.sql, buildRegisterReplaceSql(header, replace.from, replace.to, periodMonth, {
        database: args.database, controls: controls('после замены', after, methodsAfter, peopleAfter, orgsAfter, movedAfter),
      }));
      writePrivate(files.rollback, buildRegisterReplaceSql(
        [...header.slice(0, 2), `ОТКАТ: обратная замена — ведомости «${replaceMethod}» месяца снова как до замены; только если месяц не меняли после.`],
        replace.to, replace.from, periodMonth,
        { database: args.database, controls: controls('после отката (как до замены)', monthBefore, beforeByMethod, samplesBefore, orgsBefore, movedBefore) },
      ));
    } else {
      writePrivate(files.sql, buildRegisterLoadSql(input, {
        database: args.database, controls: controls('после загрузки', after, methodsAfter, peopleAfter, orgsAfter, movedAfter),
      }));
      writePrivate(files.rollback, buildRegisterRollbackSql(
        { ...input, header: [...header.slice(0, 2), 'ОТКАТ: удаляет все ведомости набора, только если их не меняли после загрузки.'] },
        { database: args.database, controls: controls('после отката (как до загрузки)', monthBefore, beforeByMethod, samplesBefore, orgsBefore, movedBefore) },
      ));
    }
    writePrivate(files.report, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    const fileSha = (file: string) => sha256(fs.readFileSync(file));
    writePrivate(files.manifest, `${JSON.stringify({
      generated_at: new Date().toISOString(),
      git_head: gitHead,
      month: args.month,
      organization_inn: set.organizationInn,
      kind: set.kind,
      payment_method_by_user: args.paymentMethod,
      duplicate_guard: {
        mode: isToPay ? 'stop' : 'warn', methods: guardMethods, text: guardLine,
        overlaps: overlapRows.map(row => ({
          employee_id: row.employee_id, payment_method: row.payment_method, number: row.doc_number, date: row.doc_date, amount: row.amount,
        })),
      },
      tag: args.tag,
      sources: set.sources.map(source => ({ file: source.name, sha256: source.sha256, documents: source.documents })),
      move_docs: movedDocs.map(doc => ({
        number: doc.docNumber, date: doc.docDate, file: doc.sourceFile, source_period: doc.sourcePeriodMonth, target_period: doc.periodMonth,
        lines: doc.lines.length, total: num(doc.totalCents), content_hash: doc.contentHash,
      })),
      already_moved: alreadyMoved.map(({ doc, storedMonth }) => ({
        number: doc.docNumber, date: doc.docDate, file: doc.sourceFile, stored_period: storedMonth,
      })),
      manual_rules: {
        links: [...manualRules.links.values()].map(rule => ({ full_name: rule.fullName, employee_id: rule.employeeId })),
        unmatched: [...manualRules.unmatched.values()].map(rule => ({ full_name: rule.fullName })),
      },
      skip_methods: args.skipMethods,
      replace_method: replaceMethod,
      ...(replace ? { replace: {
        kept_documents: replace.kept.length,
        removed_documents: replace.removed.length, removed_lines: replace.removedLines.length, removed_total: num(removedCents),
        added_documents: replace.added.length, added_lines: sqlLines.length, added_total: num(totalCents),
      } } : {}),
      counts: {
        documents: documents.length, lines: sqlLines.length, total: num(totalCents),
        matched_lines: matchedLines.length, matched_total: num(cents(matchedLines)),
        unmatched_lines: unmatchedLines.length, unmatched_total: num(cents(unmatchedLines)), employees: finalIds.length,
        skipped_documents: skipped.length, skipped_total: num(docsCents(skipped)), already_loaded: loaded.length,
        already_moved: alreadyMoved.length, moved_documents: movedDocs.length, moved_total: num(docsCents(movedDocs)),
        duplicate_00000: num(duplicateCents), not_found: notFound.length - 1, namesakes: namesakes.length - 1, review: review.length - 1,
        decisions: Object.fromEntries(DECISION_LABELS.map(([kind]) => [kind, kindCount(kind)])),
      },
      expected_after: {
        month: after, other_months: other, samples: sampleText, journal: journal.records,
        organizations: Object.fromEntries([...orgsAfter.entries()].map(([inn, t]) => [inn, { ...t, total: num(t.cents) }])),
        moved: { ...movedAfter, total: num(movedAfter.cents) },
      },
      outputs: {
        sql: { file: path.basename(files.sql), sha256: fileSha(files.sql) },
        rollback: { file: path.basename(files.rollback), sha256: fileSha(files.rollback) },
        report: { file: path.basename(files.report), sha256: fileSha(files.report) },
      },
    }, null, 2)}\n`);

    console.log(`${TAG} ведомостей ${documents.length}, строк ${sqlLines.length}, итог ${rub(totalCents)}`);
    console.log(`${TAG} с сотрудником: строк ${matchedLines.length} (${rub(cents(matchedLines))}), сотрудников ${finalIds.length}`);
    console.log(`${TAG} без сотрудника: строк ${unmatchedLines.length} (${rub(cents(unmatchedLines))});`
      + ` не найдены ${notFound.length - 1}, тёзки ${namesakes.length - 1}, проверить ${review.length - 1}`);
    console.log(`${TAG} решения: ${DECISION_LABELS.map(([kind, label]) => `${label} ${kindCount(kind)}`).join('; ')}`);
    console.log(`${TAG} не загружается ${skipped.length} (${rub(docsCents(skipped))}), уже в БД ${loaded.length},`
      + ` уже перенесены ${alreadyMoved.length}`);
    if (movedDocs.length > 0) {
      console.log(`${TAG} перенос решением пользователя: ${movedDocs.map(doc => `${doc.docNumber}`
        + ` (${monthLabelOf(doc.sourcePeriodMonth as string)})`).join(', ')} → ${monthLabel}, ${rub(docsCents(movedDocs))}`);
    }
    if (replace) {
      console.log(`${TAG} замена «${replaceMethod}»: снимается ${replace.removed.length} вед. / ${replace.removedLines.length} строк`
        + ` (${rub(removedCents)}), остаётся ${replace.kept.length}; месяц после: ${after.docs} / ${after.lines} / ${after.total}`);
    }
    for (const file of Object.values(files)) console.log(`${TAG} ${file}`);
  } finally {
    await closeDb();
  }
};

main().catch(err => {
  console.error(`${TAG} ОШИБКА: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
