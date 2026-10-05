/**
 * «Оплачено» в карточке «Зарплата → Подробно»: суммы статей «Сводной ведомости» ЗУП —
 * начислено, удержано, выплачено — по месяцам (миграции 295, 297). Вносятся вручную;
 * в расчёте зарплаты не участвуют.
 *
 * Пустая ячейка — строки нет: очистка удаляет строку, а не пишет 0.
 */
import { query, type DbExecutor } from '../../config/postgres.js';

/** Статьи — в порядке строк таблицы. Тот же список в CHECK миграции 297 и в fot-app/src/utils/payrollPaid.ts. */
export const PAYROLL_PAID_ITEM_CODES = [
  // Начислено.
  'contract',
  'bonus',
  'sick_leave',
  'overtime',
  'recalc_prev',
  'severance',
  'supplement',
  'loan',
  'vacation',
  'travel',
  'housing',
  // Удержано.
  'meals',
  'workwear',
  'safety_fine',
  'mobile',
  'fines',
  'writ_deduction',
  // Выплачено.
  'fss',
  'advance',
  'bank_transfer',
  'bonus_payout',
] as const;

export type PayrollPaidItemCode = typeof PAYROLL_PAID_ITEM_CODES[number];

/** Минус допустим только у перерасчёта за предыдущий период (сторно). Тот же CHECK — в БД. */
export const PAYROLL_PAID_NEGATIVE_ITEMS: ReadonlySet<PayrollPaidItemCode> = new Set(['recalc_prev']);

/** Сумма ячейки: месяц YYYY-MM, сумма — текстом NUMERIC. */
export interface IPayrollPaidAmount {
  month: string;
  item: PayrollPaidItemCode;
  amount: string;
}

/** Правка ячейки: amount null — очистить. */
export interface IPayrollPaidCell {
  month: string;
  item: PayrollPaidItemCode;
  amount: number | null;
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

/**
 * Записать правки ячеек: null — удалить строку, число — вставить или заменить.
 * Неизменённая сумма не перезаписывается (автор и время правки остаются прежними).
 * Вызывать в транзакции: правка карточки применяется целиком или никак.
 *
 * Возвращает число реально изменённых ячеек.
 */
export const savePaidAmounts = async (
  exec: DbExecutor,
  input: { employeeId: number; cells: IPayrollPaidCell[]; updatedBy: string },
): Promise<number> => {
  const removed = input.cells.filter(cell => cell.amount === null);
  const upserted = input.cells.filter(cell => cell.amount !== null);
  let changed = 0;

  if (removed.length > 0) {
    const res = await exec.query(
      `DELETE FROM payroll_paid_amounts p
        USING unnest($2::text[], $3::text[]) AS c(month, item)
        WHERE p.employee_id = $1
          AND p.month = (c.month || '-01')::date
          AND p.item_code = c.item`,
      [input.employeeId, removed.map(cell => cell.month), removed.map(cell => cell.item)],
    );
    changed += res.rowCount ?? 0;
  }

  if (upserted.length > 0) {
    const res = await exec.query(
      `INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount, updated_by)
       SELECT $1, (c.month || '-01')::date, c.item, c.amount, $5
         FROM unnest($2::text[], $3::text[], $4::numeric[]) AS c(month, item, amount)
       ON CONFLICT (employee_id, month, item_code) DO UPDATE
          SET amount = EXCLUDED.amount,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
        WHERE payroll_paid_amounts.amount IS DISTINCT FROM EXCLUDED.amount`,
      [
        input.employeeId,
        upserted.map(cell => cell.month),
        upserted.map(cell => cell.item),
        upserted.map(cell => cell.amount),
        input.updatedBy,
      ],
    );
    changed += res.rowCount ?? 0;
  }

  return changed;
};
