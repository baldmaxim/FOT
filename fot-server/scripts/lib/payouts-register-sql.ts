/**
 * SQL загрузки и отката ведомостей регистра выплат ЗУП в «Перечислено (1С)» (build-payouts-register-sql.ts).
 *
 * Загрузка — одна транзакция:
 *  - advisory lock по номеру и дате каждой ведомости (тот же ключ, что у загрузки XML, payoutNumberLockKey),
 *    в отсортированном порядке;
 *  - проверки: итоги набора, id ↔ ФИО сотрудника, нет другого документа с теми же номером и датой;
 *  - ведомостей нет → вставка; набор уже ровно такой (шапка, revision = 1, все строки с сотрудником и причиной,
 *    журнал пуст) → без изменений; иначе → откат;
 *  - после вставки суммы по сотрудникам сверяются с файлом.
 * Откат — только при том же полном совпадении, все ведомости сразу.
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

/** Lock, временные таблицы ожидаемого набора и итоги — общие для загрузки и отката. */
const preamble = (input: IRegisterSqlInput): string => {
  const keys = [...new Set(input.documents.map(doc => doc.lockKey))].sort();
  const methods = new Map<string, { docs: number; cents: number }>();
  for (const doc of input.documents) {
    const entry = methods.get(doc.paymentMethod) ?? { docs: 0, cents: 0 };
    methods.set(doc.paymentMethod, { docs: entry.docs + 1, cents: entry.cents + doc.totalCents });
  }
  const employees = new Map<number, number>();
  for (const line of input.lines) {
    if (line.employeeId !== null) employees.set(line.employeeId, (employees.get(line.employeeId) ?? 0) + line.amountCents);
  }
  return `\\set ON_ERROR_STOP on

BEGIN;

-- Lock по номеру и дате каждой ведомости, по порядку: параллельная загрузка XML той же ведомости ждёт.
DO $$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY[
${keys.map(key => `    ${lit(key)}`).join(',\n')}
  ]::text[] LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(k, 0));
  END LOOP;
END $$;

CREATE TEMP TABLE reg_docs (
  doc_guid uuid PRIMARY KEY, doc_number text NOT NULL, doc_date date NOT NULL, period_month date NOT NULL,
  payment_method text NOT NULL, total_amount numeric(12,2) NOT NULL, content_hash text NOT NULL, line_count integer NOT NULL
) ON COMMIT DROP;
INSERT INTO reg_docs (doc_guid, doc_number, doc_date, period_month, payment_method, total_amount, content_hash, line_count) VALUES
${values(input.documents.map(doc => [
    lit(doc.guid), lit(doc.docNumber), lit(doc.docDate), lit(doc.periodMonth), lit(doc.paymentMethod),
    money(doc.totalCents), lit(doc.contentHash), String(doc.lineCount),
  ].join(', ')))};

CREATE TEMP TABLE reg_lines (
  doc_guid uuid NOT NULL, line_no integer NOT NULL, line_key text NOT NULL, full_name_1c text NOT NULL, brigade_1c text,
  amount numeric(12,2) NOT NULL CHECK (amount > 0), employee_id integer, employee_name text, resolution text NOT NULL,
  resolution_reason text NOT NULL, PRIMARY KEY (doc_guid, line_no)
) ON COMMIT DROP;
INSERT INTO reg_lines (doc_guid, line_no, line_key, full_name_1c, brigade_1c, amount, employee_id, employee_name, resolution,
  resolution_reason) VALUES
${values(input.lines.map(line => [
    lit(line.guid), String(line.lineNo), lit(line.lineKey), lit(line.fullName), lit(line.department), money(line.amountCents),
    line.employeeId === null ? 'NULL' : String(line.employeeId), lit(line.employeeName), lit(line.resolution), lit(line.reason),
  ].join(', ')))};

CREATE TEMP TABLE reg_methods (payment_method text PRIMARY KEY, docs integer NOT NULL, total numeric(14,2) NOT NULL) ON COMMIT DROP;
INSERT INTO reg_methods (payment_method, docs, total) VALUES
${values([...methods].map(([method, entry]) => `${lit(method)}, ${entry.docs}, ${money(entry.cents)}`))};

CREATE TEMP TABLE reg_employees (employee_id integer PRIMARY KEY, total numeric(14,2) NOT NULL) ON COMMIT DROP;
${employees.size === 0 ? '' : `INSERT INTO reg_employees (employee_id, total) VALUES
${values([...employees].map(([id, cents]) => `${id}, ${money(cents)}`))};`}
`;
};

/** Сохранённое состояние ведомостей набора ровно такое, как после этой загрузки, и после неё ничего не менялось. */
const SAME_STATE_SQL = `(
    NOT EXISTS (
      (SELECT doc_guid, doc_number, NULL::text, doc_date, period_month, payment_method, NULL::text, '${PAYOUTS_1C_ORGANIZATION_INN}'::text,
              total_amount, content_hash, 1 FROM reg_docs)
      EXCEPT
      (SELECT d.doc_guid, d.doc_number, d.zup2_number, d.doc_date, d.period_month, d.payment_method, d.salary_project,
              d.organization_inn, d.total_amount, d.content_hash, d.revision
         FROM payroll_1c_payout_documents d JOIN reg_docs r ON r.doc_guid = d.doc_guid))
    AND NOT EXISTS (
      (SELECT d.doc_guid, d.doc_number, d.zup2_number, d.doc_date, d.period_month, d.payment_method, d.salary_project,
              d.organization_inn, d.total_amount, d.content_hash, d.revision
         FROM payroll_1c_payout_documents d JOIN reg_docs r ON r.doc_guid = d.doc_guid)
      EXCEPT
      (SELECT doc_guid, doc_number, NULL::text, doc_date, period_month, payment_method, NULL::text, '${PAYOUTS_1C_ORGANIZATION_INN}'::text,
              total_amount, content_hash, 1 FROM reg_docs))
    AND NOT EXISTS (
      (SELECT doc_guid, line_no, line_key, full_name_1c, NULL::uuid, brigade_1c, amount, employee_id, resolution, resolution_reason
         FROM reg_lines)
      EXCEPT
      (SELECT d.doc_guid, l.line_no, l.line_key, l.full_name_1c, l.person_id_all, l.brigade_1c, l.amount, l.employee_id,
              l.resolution, l.resolution_reason
         FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
         JOIN reg_docs r ON r.doc_guid = d.doc_guid))
    AND NOT EXISTS (
      (SELECT d.doc_guid, l.line_no, l.line_key, l.full_name_1c, l.person_id_all, l.brigade_1c, l.amount, l.employee_id,
              l.resolution, l.resolution_reason
         FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
         JOIN reg_docs r ON r.doc_guid = d.doc_guid)
      EXCEPT
      (SELECT doc_guid, line_no, line_key, full_name_1c, NULL::uuid, brigade_1c, amount, employee_id, resolution, resolution_reason
         FROM reg_lines))
    AND NOT EXISTS (
      SELECT 1 FROM payroll_1c_payout_imports i JOIN payroll_1c_payout_documents d ON d.id = i.document_id
        JOIN reg_docs r ON r.doc_guid = d.doc_guid)
  )`;

/** Проверки набора до записи: итоги, id ↔ ФИО, нет другого документа с теми же номером и датой. */
const checks = (input: IRegisterSqlInput): string => {
  const totalCents = input.documents.reduce((sum, doc) => sum + doc.totalCents, 0);
  return `  SELECT count(*), COALESCE(sum(total_amount), 0) INTO n, t FROM reg_docs;
  IF n <> ${input.documents.length} OR t <> ${money(totalCents)} THEN
    RAISE EXCEPTION 'Ведомости набора не те: %, итог %', n, t;
  END IF;
  SELECT count(*), COALESCE(sum(amount), 0) INTO n, t FROM reg_lines;
  IF n <> ${input.lines.length} OR t <> ${money(totalCents)} THEN
    RAISE EXCEPTION 'Строки набора не те: %, итог %', n, t;
  END IF;
  SELECT string_agg(d.doc_number, ', ') INTO bad FROM reg_docs d
    LEFT JOIN (SELECT doc_guid, count(*)::int AS c, sum(amount) AS s FROM reg_lines GROUP BY doc_guid) l ON l.doc_guid = d.doc_guid
   WHERE l.c IS DISTINCT FROM d.line_count OR l.s IS DISTINCT FROM d.total_amount;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Строки не сходятся с ведомостями: %', bad; END IF;
  SELECT count(*) INTO n FROM (
    (SELECT payment_method, count(*)::int, sum(total_amount) FROM reg_docs GROUP BY payment_method
     EXCEPT SELECT payment_method, docs, total FROM reg_methods)
    UNION ALL
    (SELECT payment_method, docs, total FROM reg_methods
     EXCEPT SELECT payment_method, count(*)::int, sum(total_amount) FROM reg_docs GROUP BY payment_method)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'Итоги по способам выплаты не сходятся с шапкой'; END IF;
  SELECT count(*) INTO n FROM (
    (SELECT employee_id, sum(amount) FROM reg_lines WHERE employee_id IS NOT NULL GROUP BY employee_id
     EXCEPT SELECT employee_id, total FROM reg_employees)
    UNION ALL
    (SELECT employee_id, total FROM reg_employees
     EXCEPT SELECT employee_id, sum(amount) FROM reg_lines WHERE employee_id IS NOT NULL GROUP BY employee_id)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'Суммы по сотрудникам не сходятся: %', n; END IF;
  IF EXISTS (SELECT 1 FROM reg_lines WHERE (employee_id IS NULL) <> (resolution = 'unmatched')
                                        OR (employee_id IS NULL) <> (employee_name IS NULL)) THEN
    RAISE EXCEPTION 'Сотрудник и сопоставление строки не согласованы';
  END IF;
  SELECT string_agg(DISTINCT l.employee_id || ' ' || l.employee_name, ', ') INTO bad FROM reg_lines l
    LEFT JOIN employees e ON e.id = l.employee_id AND e.full_name = l.employee_name
   WHERE l.employee_id IS NOT NULL AND e.id IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'id и ФИО сотрудника не совпали: %', bad; END IF;
  SELECT string_agg(DISTINCT d.doc_number || ' от ' || d.doc_date, ', ') INTO bad FROM payroll_1c_payout_documents d
    JOIN reg_docs r ON r.doc_number = d.doc_number AND r.doc_date = d.doc_date
   WHERE d.doc_guid <> r.doc_guid;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Эти ведомости уже загружены другим документом: %', bad; END IF;`;
};

export const buildRegisterLoadSql = (input: IRegisterSqlInput): string => {
  const docs = input.documents.length;
  return `${comment(input.header)}

${preamble(input)}
DO $$
DECLARE n integer; t numeric; bad text; existing integer;
BEGIN
${checks(input)}

  SELECT count(*) INTO existing FROM payroll_1c_payout_documents d JOIN reg_docs r ON r.doc_guid = d.doc_guid;
  IF existing = 0 THEN
    INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, zup2_number, doc_date, period_month, payment_method,
                                             salary_project, organization_inn, total_amount, content_hash, revision, updated_by)
    SELECT doc_guid, doc_number, NULL, doc_date, period_month, payment_method, NULL, '${PAYOUTS_1C_ORGANIZATION_INN}', total_amount,
           content_hash, 1, NULL
      FROM reg_docs;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> ${docs} THEN RAISE EXCEPTION 'Вставлено ведомостей %, ожидалось ${docs}', n; END IF;
    INSERT INTO payroll_1c_payout_lines (document_id, line_no, line_key, full_name_1c, person_id_all, brigade_1c, amount,
                                         employee_id, resolution, resolution_reason)
    SELECT d.id, l.line_no, l.line_key, l.full_name_1c, NULL, l.brigade_1c, l.amount, l.employee_id, l.resolution, l.resolution_reason
      FROM reg_lines l JOIN payroll_1c_payout_documents d ON d.doc_guid = l.doc_guid;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> ${input.lines.length} THEN RAISE EXCEPTION 'Вставлено строк %, ожидалось ${input.lines.length}', n; END IF;
    IF NOT ${SAME_STATE_SQL} THEN RAISE EXCEPTION 'После вставки состояние не совпало с набором'; END IF;
    SELECT count(*) INTO n FROM (
      (SELECT l.employee_id, sum(l.amount) FROM payroll_1c_payout_lines l
         JOIN payroll_1c_payout_documents d ON d.id = l.document_id JOIN reg_docs r ON r.doc_guid = d.doc_guid
        WHERE l.employee_id IS NOT NULL GROUP BY l.employee_id
       EXCEPT SELECT employee_id, total FROM reg_employees)
      UNION ALL
      (SELECT employee_id, total FROM reg_employees
       EXCEPT SELECT l.employee_id, sum(l.amount) FROM payroll_1c_payout_lines l
         JOIN payroll_1c_payout_documents d ON d.id = l.document_id JOIN reg_docs r ON r.doc_guid = d.doc_guid
        WHERE l.employee_id IS NOT NULL GROUP BY l.employee_id)) x;
    IF n <> 0 THEN RAISE EXCEPTION 'После вставки суммы по сотрудникам не сошлись: %', n; END IF;
    RAISE NOTICE 'Вставлено ведомостей: ${docs}, строк: ${input.lines.length}';
  ELSIF existing = ${docs} AND ${SAME_STATE_SQL} THEN
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

${preamble(input)}
DO $$
DECLARE n integer; existing integer;
BEGIN
  SELECT count(*) INTO existing FROM payroll_1c_payout_documents d JOIN reg_docs r ON r.doc_guid = d.doc_guid;
  IF existing <> ${docs} OR NOT ${SAME_STATE_SQL} THEN
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
