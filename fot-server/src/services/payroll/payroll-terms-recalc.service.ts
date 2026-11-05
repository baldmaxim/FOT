/**
 * Блок «Пересчёт» карточки «Зарплаты» (миграция 348): сколько доплатить после правки оклада задним числом.
 *
 * При сохранении условий с датой раньше текущего месяца сохраняются прежние условия: расчёт не хранится, и после правки
 * сумму «было» взять неоткуда. В карточке месяц считается один раз, по одним дням табеля, с текущими и прежними
 * условиями: в разницу попадают только оклад, ставка и премиальная часть, а не правки табеля. Правила выбора месяцев —
 * payroll-terms-recalc.rules.ts.
 *
 * Доплата не добавляется в расчёт следующего месяца: прошлые месяцы и так считаются по новому окладу, итог года
 * задвоился бы. «Доплачено» закрывает записи; следующая правка считается уже от доплаченного оклада.
 */
import { query, withTransaction, type DbExecutor } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { moscowTodayIso } from '../../utils/date.utils.js';
import { getPreliminaryPayoutForEmployees, toCalcTermsRow } from './payroll-calc.service.js';
import type { ICalcTermsRow } from './payroll-calc.rules.js';
import {
  lastTermsNote,
  pickRecalcMonths,
  RECALC_FINAL_PAYOUT_METHODS,
  recalcMonthRow,
  recalcTotal,
  termsChangedFrom,
  termsForMonth,
  type IRecalcMonth,
  type IRecalcNextTerms,
  type IRecalcRecord,
} from './payroll-terms-recalc.rules.js';
import { lockPayrollEmployee } from './payroll-terms.service.js';

export interface IEmployeeRecalc {
  /** Новые сверху; без разницы месяц не показывается. */
  months: IRecalcMonth[];
  /** Сумма известных разниц; минус — переплата. */
  total: string;
  /** Что закрывает «Доплачено»: все незакрытые записи на момент чтения. */
  record_ids: number[];
}

/**
 * Сохранить прежние условия перед правкой задним числом. Вызывать в транзакции сохранения условий под блокировкой
 * сотрудника и до assignTerms, который обрежет и удалит строки. Запись нужна не всегда — иначе null: дата в текущем
 * месяце, первое назначение, те же суммы.
 */
export const recordTermsRecalc = async (
  exec: DbExecutor,
  input: { employeeId: number; effectiveFrom: string; next: IRecalcNextTerms; createdBy: string },
): Promise<number | null> => {
  if (input.effectiveFrom >= `${moscowTodayIso().slice(0, 7)}-01`) return null;
  const history = (await exec.query<ICalcTermsRow>(
    `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
            calc_type,
            monthly_salary::text AS monthly_salary,
            hourly_rate::text AS hourly_rate,
            bonus_amount::text AS bonus_amount,
            proration_rounding
       FROM payroll_compensation_terms
      WHERE employee_id = $1
      ORDER BY effective_from, id`,
    [input.employeeId],
  )).rows;
  if (!termsChangedFrom(history, input.effectiveFrom, input.next)) return null;
  const inserted = await exec.query<{ id: number }>(
    `INSERT INTO payroll_terms_recalcs (employee_id, effective_from, previous_terms, paid_months_1c, created_by)
     VALUES ($1, $2::date, $3::jsonb,
             COALESCE((SELECT array_agg(DISTINCT pa.month)
                         FROM payroll_paid_amounts pa
                        WHERE pa.employee_id = $1 AND pa.item_code = 'contract'), '{}'),
             $4)
     RETURNING id`,
    [input.employeeId, input.effectiveFrom, JSON.stringify(history), input.createdBy],
  );
  return inserted.rows[0].id;
};

const loadOpenRecords = (employeeId: number): Promise<IRecalcRecord[]> => query<IRecalcRecord>(
  `SELECT id,
          to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
          to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS changed_on,
          previous_terms,
          ARRAY(SELECT to_char(m, 'YYYY-MM') FROM unnest(paid_months_1c) AS m) AS paid_months_1c
     FROM payroll_terms_recalcs
    WHERE employee_id = $1 AND settled_at IS NULL
    ORDER BY id`,
  [employeeId],
);

/** Даты ведомостей окончательного расчёта по месяцам начисления. */
const loadFinalPayoutDates = async (employeeId: number): Promise<Map<string, string[]>> => {
  const rows = await query<{ month: string; doc_date: string }>(
    `SELECT DISTINCT to_char(d.period_month, 'YYYY-MM') AS month, to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date
       FROM payroll_1c_payout_lines l
       JOIN payroll_1c_payout_documents d ON d.id = l.document_id
      WHERE l.employee_id = $1 AND d.payment_method = ANY($2::text[])`,
    [employeeId, [...RECALC_FINAL_PAYOUT_METHODS]],
  );
  const dates = new Map<string, string[]>();
  for (const row of rows) dates.set(row.month, [...(dates.get(row.month) ?? []), row.doc_date]);
  return dates;
};

/**
 * Блок «Пересчёт» сотрудника. Незакрытых записей нет (почти у всех) — ответ сразу, без расчёта. Месяцы — по очереди:
 * их мало, а расчёт незакрытого месяца читает живой табель. Месяц без расчёта (сотрудник не работал, бригада открыта)
 * строки не даёт.
 */
export const getEmployeeRecalc = async (employeeId: number, req: AuthenticatedRequest): Promise<IEmployeeRecalc> => {
  const records = await loadOpenRecords(employeeId);
  if (records.length === 0) return { months: [], total: '0.00', record_ids: [] };
  const picked = pickRecalcMonths(records, await loadFinalPayoutDates(employeeId));
  const months: IRecalcMonth[] = [];
  for (const { month, record } of picked) {
    const previousTerms = termsForMonth(record.previous_terms, month);
    const payouts = await getPreliminaryPayoutForEmployees([employeeId], month, req, undefined, {
      previousTerms: new Map([[employeeId, previousTerms]]),
    });
    const calc = payouts.get(employeeId);
    if (!calc || calc.state === 'not_closed') continue;
    const row = recalcMonthRow(month, calc.previous_net ?? null, calc.net, {
      from: lastTermsNote(previousTerms),
      to: lastTermsNote(calc.terms.map(toCalcTermsRow)),
    });
    if (row) months.push(row);
  }
  return { months, total: recalcTotal(months), record_ids: records.map(record => record.id) };
};

/** «Доплачено»: закрыть присланные незакрытые записи сотрудника. Возвращает, какие закрыл. */
export const settleEmployeeRecalc = (
  employeeId: number,
  recordIds: readonly number[],
  settledBy: string,
): Promise<number[]> => withTransaction(async client => {
  await lockPayrollEmployee(client, employeeId);
  const updated = await client.query<{ id: number }>(
    `UPDATE payroll_terms_recalcs
        SET settled_at = now(), settled_by = $3
      WHERE employee_id = $1 AND id = ANY($2::int[]) AND settled_at IS NULL
      RETURNING id`,
    [employeeId, [...recordIds], settledBy],
  );
  return updated.rows.map(row => row.id);
});
