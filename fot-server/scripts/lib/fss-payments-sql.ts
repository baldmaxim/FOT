/**
 * SQL загрузки и отката реестра «Прямые выплаты ФСС» в «Выплаты ФСС (1С)» (миграция 356, build-fss-payments-sql.ts).
 *
 * Загрузка — одна транзакция:
 *  - advisory lock по ГУИДу реестра;
 *  - проверки набора: число строк и суммы, id ↔ ФИО сотрудника, нет другого реестра с тем же номером и датой;
 *  - строк реестра нет → вставка; уже ровно этот набор → без изменений; иначе (часть строк, другое содержимое) → откат.
 * Откат — только при том же полном совпадении, все строки реестра сразу.
 * Транзакция остаётся открытой (open): в конце КОНТРОЛЬ и без COMMIT — COMMIT или ROLLBACK оператор пишет сам,
 * сверив вывод (\i в интерактивном psql).
 */

export interface IFssSqlLine {
  lineNo: number;
  fullName: string;
  personIdAll: string | null;
  sickLeaveNumber: string | null;
  reason: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  days: number | null;
  grossCents: number;
  ndflCents: number;
  amountCents: number;
  employeeId: number | null;
  /** ФИО сотрудника в ФОТ на момент сборки — проверяется при запуске. */
  employeeName: string | null;
  /** Как найден сотрудник (или почему без него). */
  resolutionReason: string;
}

export interface IFssSqlInput {
  /** Строки комментария в начале файла (без «-- »). */
  header: string[];
  registry: { guid: string; docNumber: string; docDate: string; periodMonth: string; contentHash: string };
  lines: IFssSqlLine[];
}

export interface IFssOpenTransaction {
  /** current_database(), в которой разрешён запуск. */
  database: string;
  /** Контрольные запросы после записи — с `\echo` ожидаемого результата. */
  controls: string[];
}

const lit = (value: string | null): string => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`);
const money = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
const comment = (lines: readonly string[]): string => lines.map(line => (line === '' ? '--' : `-- ${line}`)).join('\n');
const sumOf = (lines: readonly IFssSqlLine[], key: 'grossCents' | 'ndflCents' | 'amountCents'): number => (
  lines.reduce((sum, line) => sum + line[key], 0)
);

/** Поля строки, которые сравниваются: то, что видно на экране и в сверке. */
const STATE_COLUMNS = `registry_guid, registry_number, registry_date, period_month, registry_hash, line_no, full_name_1c,
          person_id_all, sick_leave_number, reason, date_from, date_to, days, amount_gross, ndfl, amount, employee_id,
          resolution_reason`;

const begin = (input: IFssSqlInput, open: IFssOpenTransaction): string => `\\set ON_ERROR_STOP on
SET client_encoding = 'UTF8';
SELECT current_database() AS db, current_user AS usr, inet_server_addr() AS server, inet_server_port() AS port;

BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF current_database() <> ${lit(open.database)} THEN RAISE EXCEPTION 'База %, ожидалась ${open.database.replace(/'/g, "''")}', current_database(); END IF;
END $$;
-- Параллельная загрузка того же реестра ждёт.
DO $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(${lit(`payroll_fss_registry:${input.registry.guid}`)}, 0)); END $$;

CREATE TEMP TABLE fss_set (
  registry_guid uuid NOT NULL, registry_number text NOT NULL, registry_date date NOT NULL, period_month date NOT NULL,
  registry_hash text NOT NULL, line_no integer PRIMARY KEY, full_name_1c text NOT NULL, person_id_all uuid,
  sick_leave_number text, reason text, date_from date, date_to date, days integer,
  amount_gross numeric(12,2) NOT NULL, ndfl numeric(12,2) NOT NULL, amount numeric(12,2) NOT NULL,
  employee_id integer, employee_name text, resolution_reason text NOT NULL
) ON COMMIT DROP;
INSERT INTO fss_set (${STATE_COLUMNS}, employee_name) VALUES
${input.lines.map(line => `  (${[
    lit(input.registry.guid), lit(input.registry.docNumber), lit(input.registry.docDate), lit(input.registry.periodMonth),
    lit(input.registry.contentHash), String(line.lineNo), lit(line.fullName), lit(line.personIdAll), lit(line.sickLeaveNumber),
    lit(line.reason), lit(line.dateFrom), lit(line.dateTo), line.days === null ? 'NULL' : String(line.days),
    money(line.grossCents), money(line.ndflCents), money(line.amountCents),
    line.employeeId === null ? 'NULL' : String(line.employeeId), lit(line.resolutionReason), lit(line.employeeName),
  ].join(', ')})`).join(',\n')};
`;

/** Строки реестра в БД ровно как набор (в обе стороны). */
const sameState = `(
    NOT EXISTS (SELECT ${STATE_COLUMNS} FROM fss_set
                EXCEPT SELECT ${STATE_COLUMNS} FROM payroll_fss_payments WHERE registry_guid = (SELECT registry_guid FROM fss_set LIMIT 1))
    AND NOT EXISTS (SELECT ${STATE_COLUMNS} FROM payroll_fss_payments WHERE registry_guid = (SELECT registry_guid FROM fss_set LIMIT 1)
                EXCEPT SELECT ${STATE_COLUMNS} FROM fss_set)
  )`;

const checks = (input: IFssSqlInput): string => `  SELECT count(*), COALESCE(sum(amount_gross), 0), COALESCE(sum(ndfl), 0), COALESCE(sum(amount), 0)
    INTO n, g, d, t FROM fss_set;
  IF n <> ${input.lines.length} OR g <> ${money(sumOf(input.lines, 'grossCents'))} OR d <> ${money(sumOf(input.lines, 'ndflCents'))}
     OR t <> ${money(sumOf(input.lines, 'amountCents'))} THEN
    RAISE EXCEPTION 'Набор строк не тот: %, всего %, НДФЛ %, на руки %', n, g, d, t;
  END IF;
  IF EXISTS (SELECT 1 FROM fss_set WHERE (employee_id IS NULL) <> (employee_name IS NULL) OR btrim(resolution_reason) = '') THEN
    RAISE EXCEPTION 'В наборе сотрудник и причина сопоставления не согласованы';
  END IF;
  SELECT string_agg(DISTINCT s.employee_id || ' ' || s.employee_name, ', ') INTO bad FROM fss_set s
    LEFT JOIN employees e ON e.id = s.employee_id AND e.full_name = s.employee_name
   WHERE s.employee_id IS NOT NULL AND e.id IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'id и ФИО сотрудника не совпали: %', bad; END IF;
  SELECT string_agg(DISTINCT p.registry_guid::text, ', ') INTO bad FROM payroll_fss_payments p
   WHERE p.registry_number = ${lit(input.registry.docNumber)} AND p.registry_date = ${lit(input.registry.docDate)}::date
     AND p.registry_guid <> ${lit(input.registry.guid)}::uuid;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Реестр ${input.registry.docNumber} от ${input.registry.docDate} уже загружен другим документом: %', bad; END IF;`;

const finish = (open: IFssOpenTransaction): string => `${open.controls.join('\n')}

\\echo
\\echo 'Транзакция ОТКРЫТА. Сверьте вывод: COMMIT; если всё верно, ROLLBACK; если нет.'
`;

export const buildFssLoadSql = (input: IFssSqlInput, open: IFssOpenTransaction): string => {
  const count = input.lines.length;
  return `${comment(input.header)}

${begin(input, open)}
DO $$
DECLARE n integer; g numeric; d numeric; t numeric; bad text; existing integer;
BEGIN
${checks(input)}

  SELECT count(*) INTO existing FROM payroll_fss_payments WHERE registry_guid = ${lit(input.registry.guid)}::uuid;
  IF existing = 0 THEN
    INSERT INTO payroll_fss_payments (${STATE_COLUMNS})
    SELECT ${STATE_COLUMNS} FROM fss_set ORDER BY line_no;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> ${count} THEN RAISE EXCEPTION 'Вставлено строк %, ожидалось ${count}', n; END IF;
    IF NOT ${sameState} THEN RAISE EXCEPTION 'После вставки строки не совпали с набором'; END IF;
    RAISE NOTICE 'Вставлено строк ФСС: ${count}';
  ELSIF existing = ${count} AND ${sameState} THEN
    RAISE NOTICE 'Без изменений: этот реестр уже загружен';
  ELSE
    RAISE EXCEPTION 'Состояние не то: из ${count} строк реестра загружено %, или их изменили — ничего не записано', existing;
  END IF;
END $$;

${finish(open)}`;
};

export const buildFssRollbackSql = (input: IFssSqlInput, open: IFssOpenTransaction): string => {
  const count = input.lines.length;
  return `${comment(input.header)}

${begin(input, open)}
DO $$
DECLARE n integer; existing integer;
BEGIN
  SELECT count(*) INTO existing FROM payroll_fss_payments WHERE registry_guid = ${lit(input.registry.guid)}::uuid;
  IF existing <> ${count} OR NOT ${sameState} THEN
    RAISE EXCEPTION 'Откат невозможен: из ${count} строк реестра загружено %, или их изменили — ничего не удалено', existing;
  END IF;
  DELETE FROM payroll_fss_payments WHERE registry_guid = ${lit(input.registry.guid)}::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> ${count} THEN RAISE EXCEPTION 'Удалено строк %, ожидалось ${count}', n; END IF;
  RAISE NOTICE 'Удалено строк ФСС: ${count}';
END $$;

${finish(open)}`;
};
