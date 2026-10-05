/**
 * «Связь» в карточке «Зарплата → Подробно» (секция «Удержание»): сверхтраты сотрудника по МТС Бизнес
 * за месяц — то, что удерживается из зарплаты. Только чтение: в условия оплаты не сохраняется.
 *
 * Сверхтраты — платный трафик сверх пакета: строки выписки с сетевым событием звонка, SMS, MMS или
 * интернет-сессии (роуминг). Абонплата, опции и услуги, подключённые компанией («Маркировка»,
 * «Бизнес-безлимит», пакеты — без события; «Мобильные сотрудники», «Удержание вызова» — событие other),
 * оплачивает компания. Поэтому сумма меньше «Расхода» в панели абонента МТС.
 *
 * Источник — `mts_business_statement_rows.amount` (рубли с НДС), без живых запросов в МТС. Номера
 * сотрудника — по `mts_business_number_map`; несколько SIM складываются. Истории привязок нет:
 * весь месяц относится текущему владельцу номера.
 */
import { queryOne } from '../../config/postgres.js';

export interface IPayrollCommunicationExpense {
  /** YYYY-MM. */
  month: string;
  /** Сколько SIM закреплено за сотрудником; 0 — «нет SIM». */
  sims: number;
  /**
   * Сверхтраты текстом NUMERIC; '0.00' — выписка за месяц есть, сверхтрат нет. null — за месяц нет ни
   * одной строки выписки («нет данных»): абонплата списывается каждый месяц, пустой месяц — не ноль.
   */
  amount: string | null;
}

/** Сетевые события платного трафика — то, что удерживается из зарплаты. */
const OVERSPEND_EVENTS = ['call', 'sms', 'mms', 'traffic'];

/** Сверхтраты по МТС за месяц month (YYYY-MM) по всем SIM сотрудника. Пополнения — не в счёт. */
export const getCommunicationExpense = async (
  employeeId: number,
  month: string,
): Promise<IPayrollCommunicationExpense> => {
  const row = await queryOne<{ sims: number; rows: number; amount: string }>(
    `SELECT COUNT(DISTINCT m.msisdn_hash)::int AS sims,
            COUNT(r.msisdn_hash)::int          AS rows,
            COALESCE(SUM(r.amount) FILTER (WHERE r.network_event = ANY($3::text[])), 0)::numeric(14,2)::text AS amount
       FROM mts_business_number_map m
       LEFT JOIN mts_business_statement_rows r
         ON r.msisdn_hash = m.msisdn_hash
        AND r.usage_date >= ($2 || '-01')::date
        AND r.usage_date < ($2 || '-01')::date + INTERVAL '1 month'
        AND r.category <> 'topups'
      WHERE m.employee_id = $1`,
    [employeeId, month, OVERSPEND_EVENTS],
  );
  if (!row || row.rows === 0) return { month, sims: row?.sims ?? 0, amount: null };
  return { month, sims: row.sims, amount: row.amount };
};
