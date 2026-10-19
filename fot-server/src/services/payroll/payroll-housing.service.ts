/**
 * «Доплата за проживание» — таблица окна «Справочник» на «Расчётах» (миграция 315).
 *
 * Источник один с окном сотрудника: housing_compensation версий условий оплаты (миграция 282).
 * Правка из таблицы меняет ТОЛЬКО проживание «с даты D и дальше» (setTermsAmountFrom).
 */
import type { PoolClient } from 'pg';

import { query } from '../../config/postgres.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll-registry-scope.service.js';
import {
  setTermsAmountFrom,
  termsPeriodParams,
  termsPeriodSql,
  type PayrollTermsPeriod,
  type TermsAmountSetResult,
} from './payroll-terms-amount.service.js';

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
 * Сотрудники «штата зарплаты» с проживанием > 0: у каждого — последняя такая версия условий в периоде
 * (на дату — действующая). «Действует с» — начало непрерывной цепочки версий с той же суммой: новая
 * версия из-за оклада не сдвигает дату доплаты.
 */
export const listHousingAllowances = async (scope: {
  contractorRootId: string | null;
  departmentIds: string[] | null;
  period: PayrollTermsPeriod;
}): Promise<IHousingAllowanceRow[]> => {
  if (scope.departmentIds?.length === 0) return [];
  return query<IHousingAllowanceRow>(
    `WITH ${payrollContractorDeptsCte('$1')},
     picked AS (
       SELECT DISTINCT ON (v.employee_id) v.employee_id, v.effective_from, v.housing_compensation
         FROM payroll_compensation_terms v
        WHERE v.housing_compensation > 0
          AND ${termsPeriodSql('v', '$3', '$4')}
        ORDER BY v.employee_id, v.effective_from DESC
     )
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
       FROM picked t
       JOIN employees e ON e.id = t.employee_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN positions p ON p.id = e.position_id
      WHERE ${payrollStaffWhereSql('e', '$2')}
      ORDER BY e.full_name, e.id`,
    [scope.contractorRootId, scope.departmentIds, ...termsPeriodParams(scope.period)],
  );
};

export type HousingSetResult = TermsAmountSetResult;

/** Проживание amount (null — снять) с даты from — см. setTermsAmountFrom. Вызывать в транзакции. */
export const setHousingFrom = (
  client: PoolClient,
  input: { employeeId: number; amount: number | null; from: string; createdBy: string },
): Promise<HousingSetResult> => setTermsAmountFrom(client, { ...input, column: 'housing_compensation' });
