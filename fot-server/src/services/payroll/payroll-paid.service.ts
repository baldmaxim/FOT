/**
 * «Оплачено» в карточке «Зарплата → Подробно»: суммы статей «Сводной ведомости» ЗУП —
 * начислено и удержано — по месяцам (миграции 295, 297, 298, 301). Только чтение: суммы
 * приходят из 1С (API или выгрузка). В расчёте зарплаты не участвуют. Суммы нет — строки нет.
 */
import { query } from '../../config/postgres.js';

/** Статьи — в порядке строк таблицы. Тот же список в CHECK миграции 301 и в fot-app/src/utils/payrollPaid.ts. */
export const PAYROLL_PAID_ITEM_CODES = [
  // Начислено.
  'contract',
  'bonus',
  'sick_leave',
  'vacation',
  // Доп. начисления.
  'housing',
  'travel',
  'overtime',
  'recalc_prev',
  'severance',
  'supplement',
  'planned_supplement',
  'loan',
  // Удержано.
  'meals',
  'workwear',
  'safety_fine',
  'fines',
  'writ_deduction',
] as const;

export type PayrollPaidItemCode = typeof PAYROLL_PAID_ITEM_CODES[number];

/**
 * Статьи раздела «Начислено» — из них столбец «Начисления» в списке условий оплаты; удержания
 * туда не идут. Тот же состав, что у итога «Начислено» в fot-app/src/utils/payrollPaid.ts.
 */
export const PAYROLL_PAID_ACCRUAL_CODES: readonly PayrollPaidItemCode[] = [
  'contract',
  'bonus',
  'sick_leave',
  'vacation',
  'housing',
  'travel',
  'overtime',
  'recalc_prev',
  'severance',
  'supplement',
  'planned_supplement',
  'loan',
];

/** Сумма ячейки: месяц YYYY-MM, сумма — текстом NUMERIC. */
export interface IPayrollPaidAmount {
  month: string;
  item: PayrollPaidItemCode;
  amount: string;
}

/** Суммы сотрудника за месяцы from — to (YYYY-MM, включительно). */
export const getPaidAmounts = async (
  employeeId: number,
  fromMonth: string,
  toMonth: string,
): Promise<IPayrollPaidAmount[]> =>
  query<IPayrollPaidAmount>(
    `SELECT to_char(month, 'YYYY-MM') AS month, item_code AS item, amount::text AS amount
       FROM payroll_paid_amounts
      WHERE employee_id = $1
        AND month BETWEEN ($2 || '-01')::date AND ($3 || '-01')::date
      ORDER BY month, item_code`,
    [employeeId, fromMonth, toMonth],
  );
