/**
 * SQL загрузки, отката и замены ведомостей регистра выплат ЗУП в «Перечислено (1С)» (build-payouts-register-sql.ts).
 *
 * Загрузка — одна транзакция:
 *  - advisory lock по номеру и дате каждой ведомости (тот же ключ, что у загрузки XML, payoutNumberLockKey),
 *    в отсортированном порядке;
 *  - проверки: итоги набора, id ↔ ФИО сотрудника, нет другого документа с теми же номером и датой;
 *  - ведомостей нет → вставка; набор уже ровно такой (шапка, revision = 1, все строки с сотрудником и причиной,
 *    журнал пуст) → без изменений; иначе → откат;
 *  - после вставки суммы по сотрудникам сверяются с файлом.
 * Откат — только при том же полном совпадении, все ведомости сразу.
 *
 * Замена месяца (from → to, оба — полные наборы месяца): документы месяца в БД обязаны быть ровно from (или уже to —
 * тогда без изменений); удаляются документы from, которых (ГУИД + хеш) нет в to, вставляются недостающие документы to.
 * Кроме advisory lock — SHARE ROW EXCLUSIVE на таблицы «Перечислено (1С)»: любая чужая запись ждёт конца транзакции.
 * Откат замены — та же замена с from и to наоборот.
 */
import { PAYOUTS_1C_ORGANIZATION_INN } from '../../src/services/payroll/payroll-1c-payouts.parser.js';

export interface IRegisterSqlDocument {
  guid: string;
  docNumber: string;
  docDate: string;
  periodMonth: string;
  paymentMethod: string;
  totalCents: number;
  contentHash: string;
  lineCount: number;
  lockKey: string;
}

export interface IRegisterSqlLine {
  guid: string;
  lineNo: number;
  lineKey: string;
  fullName: string;
  department: string | null;
  amountCents: number;
  employeeId: number | null;
  /** ФИО сотрудника в ФОТ на момент сборки — проверяется при запуске. */
  employeeName: string | null;
  resolution: 'confirmed' | 'unmatched';
  reason: string;
}

export interface IRegisterSqlInput {
  /** Строки комментария в начале файла (без «-- »). */
  header: string[];
  documents: IRegisterSqlDocument[];
  lines: IRegisterSqlLine[];
}

const lit = (value: string | null): string => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`);
const money = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
const comment = (lines: readonly string[]): string => lines.map(line => (line === '' ? '--' : `-- ${line}`)).join('\n');

const values = (rows: readonly string[]): string => rows.map(row => `  (${row})`).join(',\n');
const insertValues = (table: string, columns: string, rows: readonly string[]): string => (
  rows.length === 0 ? '' : `INSERT INTO ${table} (${columns}) VALUES\n${values(rows)};`
);

const PAYOUT_TABLES = 'payroll_1c_payout_documents, payroll_1c_payout_lines, payroll_1c_payout_imports';

/** Начало транзакции: lock по номеру и дате документов по порядку; для замены — ещё и таблицы целиком. */
const begin = (lockKeys: readonly string[], lockTables: boolean): string => `\\set ON_ERROR_STOP on

BEGIN;

-- Lock по номеру и дате каждой ведомости, по порядку: параллельная загрузка XML той же ведомости ждёт.
DO $$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY[
${[...new Set(lockKeys)].sort().map(key => `    ${lit(key)}`).join(',\n')}
  ]::text[] LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(k, 0));
  END LOOP;
END $$;
${lockTables ? `
-- После advisory lock (иначе — взаимная блокировка с загрузкой XML): любая чужая запись в «Перечислено (1С)» ждёт.
LOCK TABLE ${PAYOUT_TABLES} IN SHARE ROW EXCLUSIVE MODE;
` : ''}`;

/** Временные таблицы набора: `<p>_docs`, `<p>_lines`, `<p>_methods`, `<p>_employees`. */
const createSet = (p: string, input: IRegisterSqlInput): string => {
  const methods = new Map<string, { docs: number; cents: number }>();
  for (const doc of input.documents) {
    const entry = methods.get(doc.paymentMethod) ?? { docs: 0, cents: 0 };
    methods.set(doc.paymentMethod, { docs: entry.docs + 1, cents: entry.cents + doc.totalCents });
  }
  const employees = new Map<number, number>();
  for (const line of input.lines) {
    if (line.employeeId !== null) employees.set(line.employeeId, (employees.get(line.employeeId) ?? 0) + line.amountCents);
  }
  return `
CREATE TEMP TABLE ${p}_docs (
  doc_guid uuid PRIMARY KEY, doc_number text NOT NULL, doc_date date NOT NULL, period_month date NOT NULL,
  payment_method text NOT NULL, total_amount numeric(12,2) NOT NULL, content_hash text NOT NULL, line_count integer NOT NULL
) ON COMMIT DROP;
${insertValues(`${p}_docs`, 'doc_guid, doc_number, doc_date, period_month, payment_method, total_amount, content_hash, line_count',
    input.documents.map(doc => [
      lit(doc.guid), lit(doc.docNumber), lit(doc.docDate), lit(doc.periodMonth), lit(doc.paymentMethod),
      money(doc.totalCents), lit(doc.contentHash), String(doc.lineCount),
    ].join(', ')))}

CREATE TEMP TABLE ${p}_lines (
  doc_guid uuid NOT NULL, line_no integer NOT NULL, line_key text NOT NULL, full_name_1c text NOT NULL, brigade_1c text,
  amount numeric(12,2) NOT NULL CHECK (amount > 0), employee_id integer, employee_name text, resolution text NOT NULL,
  resolution_reason text NOT NULL, PRIMARY KEY (doc_guid, line_no)
) ON COMMIT DROP;
${insertValues(`${p}_lines`, `doc_guid, line_no, line_key, full_name_1c, brigade_1c, amount, employee_id, employee_name, resolution,
  resolution_reason`, input.lines.map(line => [
    lit(line.guid), String(line.lineNo), lit(line.lineKey), lit(line.fullName), lit(line.department), money(line.amountCents),
    line.employeeId === null ? 'NULL' : String(line.employeeId), lit(line.employeeName), lit(line.resolution), lit(line.reason),
  ].join(', ')))}

CREATE TEMP TABLE ${p}_methods (payment_method text PRIMARY KEY, docs integer NOT NULL, total numeric(14,2) NOT NULL) ON COMMIT DROP;
${insertValues(`${p}_methods`, 'payment_method, docs, total',
    [...methods].map(([method, entry]) => `${lit(method)}, ${entry.docs}, ${money(entry.cents)}`))}

CREATE TEMP TABLE ${p}_employees (employee_id integer PRIMARY KEY, total numeric(14,2) NOT NULL) ON COMMIT DROP;
${insertValues(`${p}_employees`, 'employee_id, total', [...employees].map(([id, cents]) => `${id}, ${money(cents)}`))}
`;
};

/** Сохранённое состояние документов набора ровно такое, как после загрузки, и после неё ничего не менялось. */
const sameState = (p: string): string => `(
    NOT EXISTS (
      (SELECT doc_guid, doc_number, NULL::text, doc_date, period_month, payment_method, NULL::text, '${PAYOUTS_1C_ORGANIZATION_INN}'::text,
              total_amount, content_hash, 1, NULL::uuid FROM ${p}_docs)
      EXCEPT
      (SELECT d.doc_guid, d.doc_number, d.zup2_number, d.doc_date, d.period_month, d.payment_method, d.salary_project,
              d.organization_inn, d.total_amount, d.content_hash, d.revision, d.updated_by
         FROM payroll_1c_payout_documents d JOIN ${p}_docs r ON r.doc_guid = d.doc_guid))
    AND NOT EXISTS (
      (SELECT d.doc_guid, d.doc_number, d.zup2_number, d.doc_date, d.period_month, d.payment_method, d.salary_project,
              d.organization_inn, d.total_amount, d.content_hash, d.revision, d.updated_by
         FROM payroll_1c_payout_documents d JOIN ${p}_docs r ON r.doc_guid = d.doc_guid)
      EXCEPT
      (SELECT doc_guid, doc_number, NULL::text, doc_date, period_month, payment_method, NULL::text, '${PAYOUTS_1C_ORGANIZATION_INN}'::text,
              total_amount, content_hash, 1, NULL::uuid FROM ${p}_docs))
    AND NOT EXISTS (
      (SELECT doc_guid, line_no, line_key, full_name_1c, NULL::uuid, brigade_1c, amount, employee_id, resolution, resolution_reason
         FROM ${p}_lines)
      EXCEPT
      (SELECT d.doc_guid, l.line_no, l.line_key, l.full_name_1c, l.person_id_all, l.brigade_1c, l.amount, l.employee_id,
              l.resolution, l.resolution_reason
         FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
         JOIN ${p}_docs r ON r.doc_guid = d.doc_guid))
    AND NOT EXISTS (
      (SELECT d.doc_guid, l.line_no, l.line_key, l.full_name_1c, l.person_id_all, l.brigade_1c, l.amount, l.employee_id,
              l.resolution, l.resolution_reason
         FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
         JOIN ${p}_docs r ON r.doc_guid = d.doc_guid)
      EXCEPT
      (SELECT doc_guid, line_no, line_key, full_name_1c, NULL::uuid, brigade_1c, amount, employee_id, resolution, resolution_reason
         FROM ${p}_lines))
    AND NOT EXISTS (
      SELECT 1 FROM payroll_1c_payout_imports i JOIN payroll_1c_payout_documents d ON d.id = i.document_id
        JOIN ${p}_docs r ON r.doc_guid = d.doc_guid)
  )`;

/** Документы месяца в БД — ровно документы набора (ГУИДы в обе стороны, все за этот месяц) и sameState. */
const exactMonthState = (p: string, periodMonth: string): string => `(
    ${sameState(p)}
    AND NOT EXISTS (SELECT 1 FROM ${p}_docs WHERE period_month <> ${lit(periodMonth)}::date)
    AND NOT EXISTS (
      SELECT 1 FROM payroll_1c_payout_documents d
       WHERE d.period_month = ${lit(periodMonth)}::date
         AND NOT EXISTS (SELECT 1 FROM ${p}_docs r WHERE r.doc_guid = d.doc_guid))
    AND (SELECT count(*) FROM payroll_1c_payout_documents d JOIN ${p}_docs r ON r.doc_guid = d.doc_guid)
      = (SELECT count(*) FROM ${p}_docs)
  )`;

/** Проверки набора до записи: итоги, строки ↔ документы, способы, сотрудники, id ↔ ФИО, сопоставление, номер и дата. */
const checks = (p: string, input: IRegisterSqlInput): string => {
  const totalCents = input.documents.reduce((sum, doc) => sum + doc.totalCents, 0);
  return `  SELECT count(*), COALESCE(sum(total_amount), 0) INTO n, t FROM ${p}_docs;
  IF n <> ${input.documents.length} OR t <> ${money(totalCents)} THEN
    RAISE EXCEPTION 'Ведомости набора ${p} не те: %, итог %', n, t;
  END IF;
  SELECT count(*), COALESCE(sum(amount), 0) INTO n, t FROM ${p}_lines;
  IF n <> ${input.lines.length} OR t <> ${money(totalCents)} THEN
    RAISE EXCEPTION 'Строки набора ${p} не те: %, итог %', n, t;
  END IF;
  SELECT string_agg(d.doc_number, ', ') INTO bad FROM ${p}_docs d
    LEFT JOIN (SELECT doc_guid, count(*)::int AS c, sum(amount) AS s FROM ${p}_lines GROUP BY doc_guid) l ON l.doc_guid = d.doc_guid
   WHERE l.c IS DISTINCT FROM d.line_count OR l.s IS DISTINCT FROM d.total_amount;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Строки набора ${p} не сходятся с ведомостями: %', bad; END IF;
  IF EXISTS (SELECT 1 FROM ${p}_lines l WHERE NOT EXISTS (SELECT 1 FROM ${p}_docs d WHERE d.doc_guid = l.doc_guid)) THEN
    RAISE EXCEPTION 'В наборе ${p} строки без ведомости';
  END IF;
  SELECT count(*) INTO n FROM (
    (SELECT payment_method, count(*)::int, sum(total_amount) FROM ${p}_docs GROUP BY payment_method
     EXCEPT SELECT payment_method, docs, total FROM ${p}_methods)
    UNION ALL
    (SELECT payment_method, docs, total FROM ${p}_methods
     EXCEPT SELECT payment_method, count(*)::int, sum(total_amount) FROM ${p}_docs GROUP BY payment_method)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'Итоги набора ${p} по способам выплаты не сходятся с шапкой'; END IF;
  SELECT count(*) INTO n FROM (
    (SELECT employee_id, sum(amount) FROM ${p}_lines WHERE employee_id IS NOT NULL GROUP BY employee_id
     EXCEPT SELECT employee_id, total FROM ${p}_employees)
    UNION ALL
    (SELECT employee_id, total FROM ${p}_employees
     EXCEPT SELECT employee_id, sum(amount) FROM ${p}_lines WHERE employee_id IS NOT NULL GROUP BY employee_id)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'Суммы набора ${p} по сотрудникам не сходятся: %', n; END IF;
  IF EXISTS (SELECT 1 FROM ${p}_lines WHERE resolution NOT IN ('confirmed', 'unmatched') OR btrim(resolution_reason) = ''
                                        OR (employee_id IS NULL) <> (resolution = 'unmatched')
                                        OR (employee_id IS NULL) <> (employee_name IS NULL)) THEN
    RAISE EXCEPTION 'В наборе ${p} сотрудник и сопоставление строки не согласованы';
  END IF;
  SELECT string_agg(DISTINCT l.employee_id || ' ' || l.employee_name, ', ') INTO bad FROM ${p}_lines l
    LEFT JOIN employees e ON e.id = l.employee_id AND e.full_name = l.employee_name
   WHERE l.employee_id IS NOT NULL AND e.id IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'id и ФИО сотрудника не совпали: %', bad; END IF;
  SELECT string_agg(DISTINCT d.doc_number || ' от ' || d.doc_date, ', ') INTO bad FROM payroll_1c_payout_documents d
    JOIN ${p}_docs r ON r.doc_number = d.doc_number AND r.doc_date = d.doc_date
   WHERE d.doc_guid <> r.doc_guid;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Эти ведомости уже загружены другим документом: %', bad; END IF;`;
};

/** Вставка документов набора, отобранных условием по `r` (документ набора), и их строк; n — документов, m — строк. */
const insertSet = (p: string, where: string): string => `    INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, zup2_number, doc_date, period_month, payment_method,
                                             salary_project, organization_inn, total_amount, content_hash, revision, updated_by)
    SELECT r.doc_guid, r.doc_number, NULL, r.doc_date, r.period_month, r.payment_method, NULL, '${PAYOUTS_1C_ORGANIZATION_INN}',
           r.total_amount, r.content_hash, 1, NULL
      FROM ${p}_docs r WHERE ${where};
    GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO payroll_1c_payout_lines (document_id, line_no, line_key, full_name_1c, person_id_all, brigade_1c, amount,
                                         employee_id, resolution, resolution_reason)
    SELECT d.id, l.line_no, l.line_key, l.full_name_1c, NULL, l.brigade_1c, l.amount, l.employee_id, l.resolution, l.resolution_reason
      FROM ${p}_lines l JOIN ${p}_docs r ON r.doc_guid = l.doc_guid JOIN payroll_1c_payout_documents d ON d.doc_guid = r.doc_guid
     WHERE ${where};
    GET DIAGNOSTICS m = ROW_COUNT;`;

/** Суммы по сотрудникам в сохранённых документах набора = суммы набора; иначе исключение. */
const employeeTotalsSaved = (p: string, message: string): string => `    SELECT count(*) INTO n FROM (
      (SELECT l.employee_id, sum(l.amount) FROM payroll_1c_payout_lines l
         JOIN payroll_1c_payout_documents d ON d.id = l.document_id JOIN ${p}_docs r ON r.doc_guid = d.doc_guid
        WHERE l.employee_id IS NOT NULL GROUP BY l.employee_id
       EXCEPT SELECT employee_id, total FROM ${p}_employees)
      UNION ALL
      (SELECT employee_id, total FROM ${p}_employees
       EXCEPT SELECT l.employee_id, sum(l.amount) FROM payroll_1c_payout_lines l
         JOIN payroll_1c_payout_documents d ON d.id = l.document_id JOIN ${p}_docs r ON r.doc_guid = d.doc_guid
        WHERE l.employee_id IS NOT NULL GROUP BY l.employee_id)) x;
    IF n <> 0 THEN RAISE EXCEPTION '${message}: %', n; END IF;`;

export const buildRegisterLoadSql = (input: IRegisterSqlInput): string => {
  const docs = input.documents.length;
  return `${comment(input.header)}

${begin(input.documents.map(doc => doc.lockKey), false)}
${createSet('reg', input)}
DO $$
DECLARE n integer; m integer; t numeric; bad text; existing integer;
BEGIN
${checks('reg', input)}

  SELECT count(*) INTO existing FROM payroll_1c_payout_documents d JOIN reg_docs r ON r.doc_guid = d.doc_guid;
  IF existing = 0 THEN
${insertSet('reg', 'TRUE')}
    IF n <> ${docs} THEN RAISE EXCEPTION 'Вставлено ведомостей %, ожидалось ${docs}', n; END IF;
    IF m <> ${input.lines.length} THEN RAISE EXCEPTION 'Вставлено строк %, ожидалось ${input.lines.length}', m; END IF;
    IF NOT ${sameState('reg')} THEN RAISE EXCEPTION 'После вставки состояние не совпало с набором'; END IF;
${employeeTotalsSaved('reg', 'После вставки суммы по сотрудникам не сошлись')}
    RAISE NOTICE 'Вставлено ведомостей: ${docs}, строк: ${input.lines.length}';
  ELSIF existing = ${docs} AND ${sameState('reg')} THEN
    RAISE NOTICE 'Без изменений: этот набор уже загружен';
  ELSE
    RAISE EXCEPTION 'Состояние не то: из ${docs} ведомостей загружено %, или их изменили после загрузки — ничего не записано', existing;
  END IF;
END $$;

COMMIT;
`;
};

export const buildRegisterRollbackSql = (input: IRegisterSqlInput): string => {
  const docs = input.documents.length;
  return `${comment(input.header)}

${begin(input.documents.map(doc => doc.lockKey), false)}
${createSet('reg', input)}
DO $$
DECLARE n integer; existing integer;
BEGIN
  SELECT count(*) INTO existing FROM payroll_1c_payout_documents d JOIN reg_docs r ON r.doc_guid = d.doc_guid;
  IF existing <> ${docs} OR NOT ${sameState('reg')} THEN
    RAISE EXCEPTION 'Откат невозможен: из ${docs} ведомостей загружено %, или их изменили после загрузки — ничего не удалено', existing;
  END IF;
  DELETE FROM payroll_1c_payout_documents d USING reg_docs r WHERE r.doc_guid = d.doc_guid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> ${docs} THEN RAISE EXCEPTION 'Удалено ведомостей %, ожидалось ${docs}', n; END IF;
  RAISE NOTICE 'Удалено ведомостей: ${docs} (строки — каскадом)';
END $$;

COMMIT;
`;
};

/** Документ набора, которого (ГУИД + хеш) нет в другом наборе. */
const notIn = (other: string): string => (
  `NOT EXISTS (SELECT 1 FROM ${other}_docs o WHERE o.doc_guid = r.doc_guid AND o.content_hash = r.content_hash)`
);

const pairKey = (doc: IRegisterSqlDocument): string => `${doc.guid}|${doc.contentHash}`;

/**
 * Замена документов месяца: from → to (полные наборы месяца). Откат — та же функция с from и to наоборот.
 * Документы с теми же ГУИДом и хешем не трогаются.
 */
export const buildRegisterReplaceSql = (
  header: readonly string[], from: IRegisterSqlInput, to: IRegisterSqlInput, periodMonth: string,
): string => {
  const toKeys = new Set(to.documents.map(pairKey));
  const fromKeys = new Set(from.documents.map(pairKey));
  const removed = from.documents.filter(doc => !toKeys.has(pairKey(doc)));
  const added = to.documents.filter(doc => !fromKeys.has(pairKey(doc)));
  const addedGuids = new Set(added.map(doc => doc.guid));
  const addedLines = to.lines.filter(line => addedGuids.has(line.guid)).length;
  const kept = to.documents.length - added.length;
  return `${comment([...header])}

${begin([...from.documents, ...to.documents].map(doc => doc.lockKey), true)}
${createSet('reg_from', from)}
${createSet('reg_to', to)}
DO $$
DECLARE n integer; m integer; t numeric; bad text;
BEGIN
${checks('reg_from', from)}
${checks('reg_to', to)}

  IF ${exactMonthState('reg_to', periodMonth)} THEN
    RAISE NOTICE 'Без изменений: документы месяца уже ровно этот набор';
  ELSIF ${exactMonthState('reg_from', periodMonth)} THEN
    DELETE FROM payroll_1c_payout_documents d USING reg_from_docs r WHERE r.doc_guid = d.doc_guid AND ${notIn('reg_to')};
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> ${removed.length} THEN RAISE EXCEPTION 'Удалено документов %, ожидалось ${removed.length}', n; END IF;
${insertSet('reg_to', notIn('reg_from'))}
    IF n <> ${added.length} THEN RAISE EXCEPTION 'Вставлено документов %, ожидалось ${added.length}', n; END IF;
    IF m <> ${addedLines} THEN RAISE EXCEPTION 'Вставлено строк %, ожидалось ${addedLines}', m; END IF;
    IF NOT ${exactMonthState('reg_to', periodMonth)} THEN
      RAISE EXCEPTION 'После замены документы месяца не совпали с набором';
    END IF;
${employeeTotalsSaved('reg_to', 'После замены суммы по сотрудникам не сошлись')}
    RAISE NOTICE 'Оставлено документов: ${kept}, удалено: ${removed.length}, добавлено: ${added.length} (строк ${addedLines})';
  ELSE
    RAISE EXCEPTION 'Состояние месяца не то: документы ${periodMonth} не совпадают ни с исходным, ни с новым набором — ничего не записано';
  END IF;
END $$;

COMMIT;
`;
};
