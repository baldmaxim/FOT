/**
 * «Связь» в карточке «Зарплата → Подробно» (секция «Удержание»): расход сотрудника по МТС Бизнес
 * за месяц. Только чтение: сумма считается из выписки, в условия оплаты не сохраняется.
 *
 * Источник — тот же, что у «Итого» в панели абонента (`mts_business_statement_rows.amount`,
 * рубли с НДС), без живых запросов в МТС. Номера сотрудника — по `mts_business_number_map`;
 * несколько SIM складываются. Истории привязок нет: весь месяц относится текущему владельцу номера.
 */
import { queryOne } from '../../config/postgres.js';

export interface IPayrollCommunicationExpense {
  /** YYYY-MM. */
  month: string;
  /** Сколько SIM закреплено за сотрудником; 0 — «нет SIM». */
  sims: number;
  /**
   * Сумма расхода текстом NUMERIC. null — за месяц нет ни одной строки выписки («нет данных»):
   * абонплата списывается каждый месяц, поэтому пустой месяц — это отсутствие данных, а не ноль.
   */
  amount: string | null;
}

/** Расход по МТС за месяц month (YYYY-MM) по всем SIM сотрудника. Пополнения — не расход. */
export const getCommunicationExpense = async (
  employeeId: number,
  month: string,
): Promise<IPayrollCommunicationExpense> => {
  const row = await queryOne<{ sims: number; rows: number; amount: string }>(
    `SELECT COUNT(DISTINCT m.msisdn_hash)::int AS sims,
            COUNT(r.msisdn_hash)::int          AS rows,
            COALESCE(SUM(r.amount), 0)::text   AS amount
       FROM mts_business_number_map m
       LEFT JOIN mts_business_statement_rows r
         ON r.msisdn_hash = m.msisdn_hash
        AND r.usage_date >= ($2 || '-01')::date
        AND r.usage_date < ($2 || '-01')::date + INTERVAL '1 month'
        AND r.category <> 'topups'
      WHERE m.employee_id = $1`,
    [employeeId, month],
  );
  if (!row || row.rows === 0) return { month, sims: row?.sims ?? 0, amount: null };
  return { month, sims: row.sims, amount: row.amount };
};
