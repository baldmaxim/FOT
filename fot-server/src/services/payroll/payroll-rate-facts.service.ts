/**
 * Факты месяца для «По ставкам ФОТ» (payroll-payslip.rules.ts) пачкой сотрудников: ставки «Проезд» и «Доплата
 * за общежитие» за месяц (миграция 324), «Без проезда» в месяце, проживание (квартира, общежитие) в периоде
 * сотрудника с въездом и выездом, включатель авто-доплаты за общежитие (payroll_switches, миграция 339). Ручная
 * «Доплата за общежитие» (payroll_dormitory_allowances) не читается. Одним запросом — и для листка одного сотрудника,
 * и для «К выплате (ФОТ)» всего отдела. Дни счёта (окно, отсутствия, дни бригады) решает расчёт — здесь их нет.
 */
import { query } from '../../config/postgres.js';
import type { IPayslipHousingRecord, IPayslipRateFacts } from './payroll-payslip.rules.js';
import { DORMITORY_ALLOWANCE_RATE_CODE, TRAVEL_RATE_CODE } from './payroll-rates.service.js';

/** Без категории и дней: их решает табель месяца. */
export type RateFactsRow = Omit<IPayslipRateFacts, 'category' | 'travelDays' | 'housingDays'>;

/** Ключ включателя авто-доплаты за общежитие (миграция 339). */
export const DORMITORY_ALLOWANCE_AUTO_SWITCH = 'dormitory_allowance_auto';

export const loadRateFacts = async (
  items: ReadonlyArray<{ employeeId: number; period: { from: string; to: string } }>,
  month: string,
  monthEnd: string,
): Promise<Map<number, RateFactsRow>> => {
  const result = new Map<number, RateFactsRow>();
  if (items.length === 0) return result;
  const rows = await query<{
    employee_id: number;
    travel_rate: string | null;
    dormitory_allowance_rate: string | null;
    dormitory_allowance_from: string | null;
    travel_stopped: boolean;
    housing: IPayslipHousingRecord[];
  }>(
    `SELECT p.employee_id,
            payroll_rate_value($4, $2::date)::text AS travel_rate,
            payroll_rate_value($5, $2::date)::text AS dormitory_allowance_rate,
            (SELECT to_char(sw.active_from, 'YYYY-MM-DD') FROM payroll_switches sw WHERE sw.key = $8)
              AS dormitory_allowance_from,
            EXISTS (
              SELECT 1 FROM payroll_compensation_stops cs
               WHERE cs.employee_id = p.employee_id
                 AND cs.date_from <= $3::date
                 AND (cs.date_to IS NULL OR cs.date_to >= $2::date)
            ) AS travel_stopped,
            COALESCE((
              SELECT json_agg(h ORDER BY h.start)
                FROM (
                  SELECT s.kind, to_char(s.check_in, 'YYYY-MM-DD') AS start,
                         to_char(s.check_out, 'YYYY-MM-DD') AS "end", s.amount::text AS amount
                    FROM employee_dormitory_stays s
                   WHERE s.employee_id = p.employee_id
                     AND s.check_in <= p.period_to
                     AND (s.check_out IS NULL OR s.check_out > p.period_from)
                ) h
            ), '[]'::json) AS housing
       FROM unnest($1::int[], $6::date[], $7::date[]) AS p(employee_id, period_from, period_to)`,
    [
      items.map(item => item.employeeId),
      `${month}-01`,
      monthEnd,
      TRAVEL_RATE_CODE,
      DORMITORY_ALLOWANCE_RATE_CODE,
      items.map(item => item.period.from),
      items.map(item => item.period.to),
      DORMITORY_ALLOWANCE_AUTO_SWITCH,
    ],
  );
  for (const row of rows ?? []) {
    result.set(Number(row.employee_id), {
      travelRate: row.travel_rate ?? null,
      travelStopped: row.travel_stopped ?? false,
      dormitoryAllowanceRate: row.dormitory_allowance_rate ?? null,
      dormitoryAllowanceFrom: row.dormitory_allowance_from ?? null,
      housing: row.housing ?? [],
    });
  }
  return result;
};
