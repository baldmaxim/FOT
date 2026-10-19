/**
 * «Доплата за проживание» — таблица окна «Справочник» на «Расчётах» (миграция 315).
 *
 * Источник один с окном сотрудника: housing_compensation версий условий оплаты (миграция 282).
 * Правка из таблицы меняет ТОЛЬКО проживание «с даты D и дальше»: версия на D делится на две
 * (до D и с D — копия всех столбцов с прежним effective_to), у поздних версий меняется только
 * проживание. assignTerms для этого не годится: он удаляет версии с D и позже и создаёт строку
 * с effective_to = NULL — заодно переписал бы оклад, учёт времени и запланированные изменения.
 */
import type { PoolClient } from 'pg';

import { query } from '../../config/postgres.js';
import { lockPayrollEmployee } from './payroll-terms.service.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll-registry-scope.service.js';

export interface IHousingAllowanceRow {
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** ₽/мес, numeric строкой. */
  amount: string;
  /** YYYY-MM-DD: с какой даты подряд действует эта сумма (смена оклада дату не сбрасывает). */
  effective_from: string;
}

/**
 * Сотрудники «штата зарплаты» с проживанием > 0 в условиях на дату onDate. «Действует с» — начало
 * непрерывной цепочки версий с той же суммой: новая версия из-за оклада не сдвигает дату доплаты.
 */
export const listHousingAllowances = async (scope: {
  contractorRootId: string | null;
  departmentIds: string[] | null;
  onDate: string;
}): Promise<IHousingAllowanceRow[]> => {
  if (scope.departmentIds?.length === 0) return [];
  return query<IHousingAllowanceRow>(
    `WITH ${payrollContractorDeptsCte('$1')}
     SELECT e.id AS employee_id,
            e.full_name,
            d.name AS department,
            p.name AS position,
            t.housing_compensation::text AS amount,
            to_char((
              SELECT min(v.effective_from)
                FROM payroll_compensation_terms v
               WHERE v.employee_id = t.employee_id
                 AND v.effective_from <= t.effective_from
                 AND v.effective_from > COALESCE((
                   SELECT max(w.effective_from)
                     FROM payroll_compensation_terms w
                    WHERE w.employee_id = t.employee_id
                      AND w.effective_from < t.effective_from
                      AND w.housing_compensation IS DISTINCT FROM t.housing_compensation
                 ), '-infinity'::date)
            ), 'YYYY-MM-DD') AS effective_from
       FROM payroll_compensation_terms t
       JOIN employees e ON e.id = t.employee_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN positions p ON p.id = e.position_id
      WHERE t.effective_from <= $3::date
        AND (t.effective_to IS NULL OR t.effective_to >= $3::date)
        AND t.housing_compensation > 0
        AND ${payrollStaffWhereSql('e', '$2')}
      ORDER BY e.full_name, e.id`,
    [scope.contractorRootId, scope.departmentIds, scope.onDate],
  );
};

export type HousingSetResult =
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
  housing: string | null;
}

/**
 * Проживание amount (null — снять) с даты from: версия на from делится, поздние версии получают ту же
 * сумму. Остальные столбцы и границы версий не меняются. Нет условий на from — 'no_terms';
 * сумма уже такая с from и дальше — 'unchanged'. Вызывать в транзакции.
 */
export const setHousingFrom = async (
  client: PoolClient,
  input: { employeeId: number; amount: number | null; from: string; createdBy: string },
): Promise<HousingSetResult> => {
  await lockPayrollEmployee(client, input.employeeId);

  const current = (await client.query<ICurrentVersion>(
    `SELECT id,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
            housing_compensation::text AS housing
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
          AND housing_compensation IS DISTINCT FROM $4::numeric
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
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO payroll_compensation_terms
         (employee_id, organization_id, staff_category, calc_type, monthly_salary, hourly_rate,
          staff_units, time_accounting_mode, accounting_period_months,
          effective_from, effective_to, change_reason, order_number, order_date, note, created_by,
          bonus_amount, housing_compensation, travel_compensation, communication_compensation, deduction_amount)
       SELECT employee_id, organization_id, staff_category, calc_type, monthly_salary, hourly_rate,
              staff_units, time_accounting_mode, accounting_period_months,
              $2::date, $3::date, change_reason, order_number, order_date, note, $4::uuid,
              bonus_amount, $5::numeric, travel_compensation, communication_compensation, deduction_amount
         FROM payroll_compensation_terms
        WHERE id = $1
       RETURNING id`,
      [current.id, input.from, current.effective_to, input.createdBy, input.amount],
    );
    termsId = inserted.rows[0].id;
  } else {
    await client.query(
      `UPDATE payroll_compensation_terms
          SET housing_compensation = $2::numeric, updated_at = now()
        WHERE id = $1`,
      [current.id, input.amount],
    );
  }

  // «С D и дальше»: уже запланированная новая версия (смена оклада) не должна вернуть прежнюю доплату.
  const later = await client.query(
    `UPDATE payroll_compensation_terms
        SET housing_compensation = $3::numeric, updated_at = now()
      WHERE employee_id = $1
        AND effective_from > $2::date
        AND housing_compensation IS DISTINCT FROM $3::numeric`,
    [input.employeeId, input.from, input.amount],
  );

  return {
    status: 'saved',
    termsId,
    previousTermsId: current.id,
    previousAmount: current.housing,
    laterUpdated: later.rowCount ?? 0,
  };
};
