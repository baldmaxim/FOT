/**
 * Одна сумма версий условий оплаты — для таблиц окна «Справочник» на «Расчётах»: «Доплата за проживание»
 * (housing_compensation) и «Удержания» (deduction_amount).
 *
 * Правка из таблицы меняет ТОЛЬКО эту сумму «с даты D и дальше»: версия на D делится на две
 * (до D и с D — копия всех столбцов с прежним effective_to), у поздних версий меняется только
 * эта сумма. assignTerms для этого не годится: он удаляет версии с D и позже и создаёт строку
 * с effective_to = NULL — заодно переписал бы оклад, учёт времени и запланированные изменения.
 */
import type { PoolClient } from 'pg';

import { lockPayrollEmployee } from './payroll-terms.service.js';

/** Суммы, которые таблицы «Справочника» правят точечно. Имя столбца в SQL — только из этого списка. */
export type PayrollTermsAmountColumn = 'housing_compensation' | 'deduction_amount';

const AMOUNT_COLUMNS: ReadonlySet<PayrollTermsAmountColumn> = new Set(['housing_compensation', 'deduction_amount']);

/** Столбцы версии, которые копируются при разрезе (кроме дат и автора — их задаёт разрез). */
const COPIED_COLUMNS = [
  'employee_id', 'organization_id', 'staff_category', 'calc_type', 'monthly_salary', 'hourly_rate',
  'staff_units', 'time_accounting_mode', 'accounting_period_months',
  'change_reason', 'order_number', 'order_date', 'note',
  'bonus_amount', 'housing_compensation', 'travel_compensation', 'communication_compensation', 'deduction_amount',
] as const;

export type TermsAmountSetResult =
  | { status: 'no_terms' }
  | { status: 'unchanged' }
  | {
    status: 'saved';
    /** Версия, действующая с D (новая копия или прежняя, если она начиналась в D). */
    termsId: number;
    previousTermsId: number;
    previousAmount: string | null;
    /** Сколько поздних версий получили новую сумму. */
    laterUpdated: number;
  };

interface ICurrentVersion {
  id: number;
  effective_from: string;
  effective_to: string | null;
  amount: string | null;
}

/**
 * Сумма column = amount (null — снять) с даты from: версия на from делится, поздние версии получают ту же
 * сумму. Остальные столбцы и границы версий не меняются. Нет условий на from — 'no_terms';
 * сумма уже такая с from и дальше — 'unchanged'. Вызывать в транзакции.
 */
export const setTermsAmountFrom = async (
  client: PoolClient,
  input: { column: PayrollTermsAmountColumn; employeeId: number; amount: number | null; from: string; createdBy: string },
): Promise<TermsAmountSetResult> => {
  if (!AMOUNT_COLUMNS.has(input.column)) throw new Error(`Неизвестная сумма условий: ${input.column}`);
  const column = input.column;
  await lockPayrollEmployee(client, input.employeeId);

  const current = (await client.query<ICurrentVersion>(
    `SELECT id,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
            ${column}::text AS amount
       FROM payroll_compensation_terms
      WHERE employee_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      FOR UPDATE`,
    [input.employeeId, input.from],
  )).rows[0];
  if (!current) return { status: 'no_terms' };

  const differs = (await client.query<{ differs: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM payroll_compensation_terms
        WHERE employee_id = $1
          AND (id = $2 OR effective_from > $3::date)
          AND ${column} IS DISTINCT FROM $4::numeric
     ) AS differs`,
    [input.employeeId, current.id, input.from, input.amount],
  )).rows[0]?.differs === true;
  if (!differs) return { status: 'unchanged' };

  let termsId = current.id;
  if (current.effective_from < input.from) {
    // Сначала закрываем версию: EXCLUDE проверяется сразу, копия с D пересеклась бы с ней.
    await client.query(
      `UPDATE payroll_compensation_terms
          SET effective_to = ($2::date - INTERVAL '1 day')::date, updated_at = now()
        WHERE id = $1`,
      [current.id, input.from],
    );
    const values = COPIED_COLUMNS.map(name => (name === column ? '$5::numeric' : name));
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO payroll_compensation_terms (${COPIED_COLUMNS.join(', ')}, effective_from, effective_to, created_by)
       SELECT ${values.join(', ')}, $2::date, $3::date, $4::uuid
         FROM payroll_compensation_terms
        WHERE id = $1
       RETURNING id`,
      [current.id, input.from, current.effective_to, input.createdBy, input.amount],
    );
    termsId = inserted.rows[0].id;
  } else {
    await client.query(
      `UPDATE payroll_compensation_terms
          SET ${column} = $2::numeric, updated_at = now()
        WHERE id = $1`,
      [current.id, input.amount],
    );
  }

  // «С D и дальше»: уже запланированная новая версия (смена оклада) не должна вернуть прежнюю сумму.
  const later = await client.query(
    `UPDATE payroll_compensation_terms
        SET ${column} = $3::numeric, updated_at = now()
      WHERE employee_id = $1
        AND effective_from > $2::date
        AND ${column} IS DISTINCT FROM $3::numeric`,
    [input.employeeId, input.from, input.amount],
  );

  return {
    status: 'saved',
    termsId,
    previousTermsId: current.id,
    previousAmount: current.amount,
    laterUpdated: later.rowCount ?? 0,
  };
};

/**
 * Какие версии условий показывает таблица: onDate — действующая на дату (прежнее «на сегодня»);
 * monthStarts — пересекающие хоть один из месяцев (первые числа), null — весь период.
 */
export type PayrollTermsPeriod = { onDate: string } | { monthStarts: string[] | null };

/** Параметры периода для termsPeriodSql: [дата или null, месяцы или null]. */
export const termsPeriodParams = (period: PayrollTermsPeriod): [string | null, string[] | null] => (
  'onDate' in period ? [period.onDate, null] : [null, period.monthStarts]
);

/**
 * Условие на версию alias: на дату dateParam или пересечение с месяцами monthsParam (оба NULL — без
 * ограничения). Параметры — плейсхолдеры запроса ($N) из termsPeriodParams.
 */
export const termsPeriodSql = (alias: string, dateParam: string, monthsParam: string): string => `(
       CASE WHEN ${dateParam}::date IS NOT NULL
            THEN ${alias}.effective_from <= ${dateParam}::date
                 AND (${alias}.effective_to IS NULL OR ${alias}.effective_to >= ${dateParam}::date)
            ELSE ${monthsParam}::date[] IS NULL OR EXISTS (
              SELECT 1 FROM unnest(${monthsParam}::date[]) AS m(start)
               WHERE ${alias}.effective_from < (m.start + INTERVAL '1 month')::date
                 AND (${alias}.effective_to IS NULL OR ${alias}.effective_to >= m.start)
            )
       END)`;
