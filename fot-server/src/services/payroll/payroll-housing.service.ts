/**
 * «Доплата за проживание» — таблица окна «Справочник» на «Расчётах» (миграции 315, 320).
 *
 * Источник — квартиры «Проживания» (employee_dormitory_stays kind = apartment): одни и те же записи ведут
 * кадры («Управление кадрами» → «Проживание») и «Зарплата» (эта таблица). Строка — одно проживание в квартире:
 * въезд, выезд ([въезд, выезд), пусто — живёт), сумма ₽/мес, адрес. Запись — через сервис проживаний.
 */
import { query } from '../../config/postgres.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll-registry-scope.service.js';
import type { PayrollTermsPeriod } from './payroll-terms-amount.service.js';

export interface IHousingAllowanceRow {
  /** id проживания: ✎ и 🗑 работают с ним. */
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** ₽/мес, numeric строкой. */
  amount: string;
  /** YYYY-MM-DD. */
  check_in: string;
  /** YYYY-MM-DD — день выезда (не включается); живёт — null. */
  check_out: string | null;
  address: string | null;
}

/** Параметры периода: [дата или null, первые числа месяцев или null] — как у termsPeriodParams. */
const periodParams = (period: PayrollTermsPeriod): [string | null, string[] | null] => (
  'onDate' in period ? [period.onDate, null] : [null, period.monthStarts]
);

/**
 * Квартиры «штата зарплаты»: на дату — проживание, идущее в этот день; месяцы — задевающее хоть один
 * (выезд в 1-е число месяца — в нём уже не жил); оба NULL — все, с историей. Порядок — ФИО, въезд.
 */
export const listHousingAllowances = async (scope: {
  contractorRootId: string | null;
  departmentIds: string[] | null;
  period: PayrollTermsPeriod;
}): Promise<IHousingAllowanceRow[]> => {
  if (scope.departmentIds?.length === 0) return [];
  return query<IHousingAllowanceRow>(
    `WITH ${payrollContractorDeptsCte('$1')}
     SELECT s.id, s.employee_id, e.full_name, d.name AS department, p.name AS position,
            s.amount::text AS amount,
            to_char(s.check_in, 'YYYY-MM-DD') AS check_in,
            to_char(s.check_out, 'YYYY-MM-DD') AS check_out,
            s.address
       FROM employee_dormitory_stays s
       JOIN employees e ON e.id = s.employee_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN positions p ON p.id = e.position_id
      WHERE s.kind = 'apartment'
        AND ${payrollStaffWhereSql('e', '$2')}
        AND CASE WHEN $3::date IS NOT NULL
                 THEN s.check_in <= $3::date AND (s.check_out IS NULL OR s.check_out > $3::date)
                 ELSE $4::date[] IS NULL OR EXISTS (
                   SELECT 1 FROM unnest($4::date[]) AS m(start)
                    WHERE s.check_in < (m.start + INTERVAL '1 month')::date
                      AND (s.check_out IS NULL OR s.check_out > m.start)
                 )
            END
      ORDER BY e.full_name, e.id, s.check_in, s.id`,
    [scope.contractorRootId, scope.departmentIds, ...periodParams(scope.period)],
  );
};
