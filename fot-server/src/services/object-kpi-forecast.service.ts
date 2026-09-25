import { query } from '../config/postgres.js';
import {
  OBJECT_KPI_REPORT_SQL,
  shiftMonth,
  type ObjectKpiReportRow,
} from './object-kpi-report.service.js';

/**
 * Прогноз KPI объекта от следующего месяца до месяца контрольной даты — при выполнении
 * плана на 100 %:
 *
 *   КС-6(C+1)  = КС-2 накопительно на начало C+1 + (КС-2 за C не внесены ? план C : 0)
 *   остаток(M) = договор с ДС(M) − КС-6(M)
 *   план(M)    = остаток(M) / мес.(M)
 *   КС-2(M)    = план(M)
 *   КС-6(M+1)  = КС-6(M) + план(M)
 *
 * Текущий месяц C: пока КС-2 за него не внесены, он считается выполненным на 100 %, иначе
 * прогноз в начале месяца завышал бы планы всех следующих месяцев. Как только акты внесены,
 * прогноз идёт от внесённой суммы — больше она плана или меньше.
 *
 * Последний месяц — месяц контрольной даты (мес. = 1): план равен всему остатку, после
 * него остаток 0. Строки строятся, пока остаток > 0: закрытый договор нулевыми строками до
 * контрольной даты не дорисовывается — нулевой план по п. 4.5 не рассчитывается.
 *
 * Горизонт берётся из строки C+1, а не из строки C. У зафиксированного C контрольная дата
 * закреплена снимком, а будущие месяцы считаются по текущей плановой ЗОС (п. 6.3). Возьми
 * горизонт из C — и после переноса ЗОС рекурсия оборвалась бы не там, где число месяцев
 * дошло до 1.
 *
 * Договор, накопление и число месяцев не считаются здесь заново: оба запроса — это
 * OBJECT_KPI_REPORT_SQL, как и у премии. Прогноз добавляет только рекурсию «план = факт».
 */

export interface ObjectKpiForecastRow extends ObjectKpiReportRow {
  is_forecast: true;
}

// $1 — текущий месяц C (начало окна отчёта), $2 — месяц контрольной даты, $3 — объект.
export const OBJECT_KPI_FORECAST_SQL = `
WITH RECURSIVE rep AS (
${OBJECT_KPI_REPORT_SQL}
),
cur AS (
  SELECT * FROM rep WHERE period_month = to_char($1::date, 'YYYY-MM-DD')
),
fc AS (
  SELECT
    n.period_month,
    s.ks6_before::numeric                                                AS ks6_before,
    (n.contract_total - s.ks6_before)::numeric                           AS remainder,
    n.months_remaining,
    ROUND((n.contract_total - s.ks6_before) / n.months_remaining, 2)::numeric AS plan
  FROM rep n
  -- Без строки текущего месяца или без его плана прогноза нет: не от чего считать.
  CROSS JOIN LATERAL (
    SELECT n.ks2_cumulative_before
      + CASE WHEN c.fact_acts > 0 OR c.fact_reductions < 0 THEN 0 ELSE c.plan_amount END AS ks6_before
      FROM cur c
     WHERE c.plan_amount IS NOT NULL
  ) s
  WHERE n.period_month = to_char(($1::date + INTERVAL '1 month')::date, 'YYYY-MM-DD')
    AND n.contract_total IS NOT NULL
    AND n.months_remaining IS NOT NULL
  UNION ALL
  SELECT
    n.period_month,
    (f.ks6_before + f.plan)::numeric,
    (n.contract_total - (f.ks6_before + f.plan))::numeric,
    n.months_remaining,
    ROUND((n.contract_total - (f.ks6_before + f.plan)) / n.months_remaining, 2)::numeric
  FROM fc f
  JOIN rep n
    ON n.period_month = to_char((f.period_month::date + INTERVAL '1 month')::date, 'YYYY-MM-DD')
  WHERE f.months_remaining > 1
    AND n.contract_total - (f.ks6_before + f.plan) > 0
)
SELECT
  r.skud_object_id,
  r.object_name,
  r.object_is_active,
  r.period_month,
  r.contract_id,
  r.contract_number,
  r.customer_name,
  r.planned_zos_date,
  r.actual_zos_date,
  r.planned_zos_date_used,
  r.control_date,
  r.is_overdue,
  r.contract_total,
  f.ks6_before          AS ks2_cumulative_before,
  f.ks6_before + f.plan AS ks2_cumulative_after,
  f.remainder,
  f.months_remaining,
  f.plan                AS plan_amount,
  f.plan                AS plan_amount_calc,
  f.plan                AS fact_amount,
  f.plan                AS fact_acts,
  0::numeric            AS fact_reductions,
  100.00::numeric       AS completion_pct,
  false                 AS plan_overridden,
  'open'::text          AS report_status,
  r.data_quality,
  false                 AS over_contract,
  NULL::uuid            AS month_plan_id,
  NULL::text            AS stored_plan_status,
  r.managers,
  r.primary_manager_id,
  r.primary_manager_name,
  true                  AS is_forecast
FROM fc f
JOIN rep r ON r.period_month = f.period_month
WHERE f.remainder > 0
ORDER BY f.period_month
`;

/**
 * Прогнозные строки объекта после текущего месяца. Пустой массив, если прогнозировать
 * нечего: ЗОС получен, данных для плана нет, расчёт ещё не начался или договор закрыт.
 *
 * @param currentMonth текущий месяц, `YYYY-MM`
 */
export async function fetchObjectKpiForecast(
  objectId: string,
  currentMonth: string,
): Promise<ObjectKpiForecastRow[]> {
  const nextMonth = shiftMonth(currentMonth, 1);

  const nextRows = await query<Pick<ObjectKpiReportRow, 'control_date'>>(OBJECT_KPI_REPORT_SQL, [
    `${nextMonth}-01`,
    `${nextMonth}-01`,
    [objectId],
  ]);
  const controlDate = nextRows[0]?.control_date ?? null;
  if (!controlDate) return [];

  // Контрольная дата уже прошла — у C+1 по п. 2.7 один месяц, окно из C и C+1.
  const controlMonth = controlDate.slice(0, 7);
  const lastMonth = controlMonth > nextMonth ? controlMonth : nextMonth;

  return query<ObjectKpiForecastRow>(OBJECT_KPI_FORECAST_SQL, [
    `${currentMonth}-01`,
    `${lastMonth}-01`,
    [objectId],
  ]);
}

