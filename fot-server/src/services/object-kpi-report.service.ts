import { query } from '../config/postgres.js';

/**
 * Сводный отчёт KPI закрытия КС-2 — ОДИН SQL на всё окно и все объекты.
 *
 * Формулы приказа:
 *   contract_total(M)   = base_amount + Σ ДС(signed), effective_date <= 1-е число M
 *   ks2_cumulative(M-1) = Σ КС-2(signed), customer_signed_date <= последний день M-1
 *   remainder(M)        = GREATEST(contract_total − ks2_cumulative, 0)          (п. 2.2)
 *   control_date        = planned_zos_date + 3 месяца                           (п. 2.4)
 *   months_remaining(M) = мес(control) − мес(M) + 1, но не меньше 1             (п. 2.5–2.7)
 *   plan(M)             = remainder / months_remaining                          (п. 2.6)
 *   fact(M)             = Σ КС-2(signed) с period_month = M                     (п. 3.1)
 *   completion(M)       = fact / plan × 100                                     (п. 3.4)
 *
 * Обе половины остатка берутся на ОДИН момент — начало месяца M. Отсюда граница
 * ДС `<= 1-е число`, а не `<= последний день месяца`: иначе допник, заехавший
 * 25-го числа, менял бы уже зафиксированный план, и сигнал plan_drift («после
 * фиксации в исходные данные что-то заехало») превратился бы в постоянный шум.
 *
 * Карточка одного объекта — ЭТОТ ЖЕ запрос с $3 = ARRAY[objectId]. Дублировать
 * формулы вторым запросом нельзя: расхождение сводного отчёта и карточки по одному
 * объекту — худший из возможных багов доверия.
 */

export interface ObjectKpiReportRow {
  skud_object_id: string;
  object_name: string;
  object_is_active: boolean;
  period_month: string;
  contract_id: string | null;
  contract_number: string | null;
  customer_name: string | null;
  planned_zos_date: string | null;
  actual_zos_date: string | null;
  planned_zos_date_used: string | null;
  control_date: string | null;
  is_overdue: boolean;
  contract_total: string | null;
  ks2_cumulative_before: string | null;
  ks2_cumulative_after: string | null;
  /** КС-6 — СПРАВОЧНО. В план, остаток и факт не входит (см. 243_object_ks6_entries.sql). */
  ks6_cumulative_after: string | null;
  ks6_month_amount: string;
  remainder: string | null;
  months_remaining: number | null;
  plan_amount: string | null;
  plan_amount_calc: string | null;
  fact_amount: string;
  fact_acts: string;
  fact_reductions: string;
  completion_pct: string | null;
  plan_source: 'snapshot' | 'calculated';
  plan_overridden: boolean;
  plan_drift: boolean;
  report_status: 'open' | 'fixed' | 'corrected' | 'data_incomplete';
  data_quality: 'ok' | 'no_active_contract' | 'no_base_amount' | 'no_planned_zos_date';
  over_contract: boolean;
  month_plan_id: string | null;
  stored_plan_status: string | null;
  managers: Array<{ employee_id: number; full_name: string | null; days: number }>;
  primary_manager_id: number | null;
  primary_manager_name: string | null;
}

/**
 * Запрос держится одной экспортируемой константой: версионируется в git и
 * переиспользуется тестами, чтобы «карточка» и «отчёт» физически не разъехались.
 */
export const OBJECT_KPI_REPORT_SQL = `
WITH params AS (
  SELECT
    date_trunc('month', $1::date::timestamp)::date AS month_from,
    date_trunc('month', $2::date::timestamp)::date AS month_to,
    $3::uuid[]                                     AS object_ids
),
months AS (
  -- ::timestamp обязателен: без него шаг «месяц» считается в таймзоне сессии,
  -- и на хосте с UTC границы месяцев уедут.
  SELECT generate_series(
           (SELECT month_from FROM params)::timestamp,
           (SELECT month_to   FROM params)::timestamp,
           INTERVAL '1 month'
         )::date AS period_month
),
scope AS (
  SELECT
    o.id                AS skud_object_id,
    o.name              AS object_name,
    o.is_active         AS object_is_active,
    c.id                AS contract_id,
    c.contract_number,
    c.customer_name,
    c.base_amount,
    c.planned_zos_date,
    c.actual_zos_date,
    c.plan_start_month,
    c.planned_headcount
  FROM skud_objects o
  -- CROSS JOIN, а не «= ANY((SELECT object_ids FROM params))». Две формы ANY пишутся
  -- одинаково, но значат разное: ANY(подзапрос) сравнивает со МНОЖЕСТВОМ строк, и
  -- запрос падал на «operator does not exist: uuid = uuid[]» при любых данных.
  -- ANY(массив) требует именно выражения-массива — его и даёт p.object_ids.
  CROSS JOIN params p
  LEFT JOIN object_contracts c
         ON c.skud_object_id = o.id
        AND c.is_active = true
  WHERE o.id = ANY(p.object_ids)
),
-- «Хвост истории» ДО начала окна. Оконная сумма ниже видит только строки решётки,
-- а решётка начинается с month_from. Кардинальность O(объекты), не O(объекты × месяцы).
baselines AS (
  SELECT
    s.skud_object_id,
    COALESCE((
      SELECT SUM(k.amount)
        FROM object_ks2_entries k
       WHERE k.skud_object_id = s.skud_object_id
         AND k.status = 'signed'
         AND k.customer_signed_date < (SELECT month_from FROM params)
    ), 0::numeric) AS ks2_before_window,
    COALESCE((
      SELECT SUM(a.amount_delta)
        FROM object_contract_addenda a
       WHERE a.contract_id = s.contract_id
         AND a.status = 'signed'
         AND a.effective_date <= (SELECT month_from FROM params)
    ), 0::numeric) AS addenda_before_window,
    -- КС-6 — справочная величина, копится отдельно и ни в одну формулу не входит.
    COALESCE((
      SELECT SUM(k6.amount)
        FROM object_ks6_entries k6
       WHERE k6.skud_object_id = s.skud_object_id
         AND k6.status = 'signed'
         AND k6.customer_signed_date < (SELECT month_from FROM params)
    ), 0::numeric) AS ks6_before_window
  FROM scope s
),
ks2_monthly AS (
  SELECT
    k.skud_object_id,
    k.period_month,
    SUM(k.amount)                                                   AS fact_net,
    COALESCE(SUM(k.amount) FILTER (WHERE k.entry_kind = 'act'), 0)       AS fact_acts,
    COALESCE(SUM(k.amount) FILTER (WHERE k.entry_kind = 'reduction'), 0) AS fact_reductions
  FROM object_ks2_entries k
  CROSS JOIN params p
  WHERE k.status = 'signed'
    AND k.skud_object_id = ANY(p.object_ids)
    -- Полуинтервал по customer_signed_date, а не по period_month: ключ индекса
    -- именно эта колонка, иначе Index Only Scan не сработает.
    AND k.customer_signed_date >= p.month_from
    AND k.customer_signed_date <  (p.month_to + INTERVAL '1 month')
  GROUP BY k.skud_object_id, k.period_month
),
ks6_monthly AS (
  -- КС-6 — СПРАВОЧНАЯ величина (см. 243_object_ks6_entries.sql): ни план, ни остаток,
  -- ни факт её не видят, приказ считает KPI по КС-2 (п. 3.1). Отдельный CTE, а не FILTER
  -- внутри ks2_monthly: таблицы разные, и объединение агрегатов ради одной справочной
  -- колонки читается хуже, чем шесть лишних строк.
  SELECT
    k6.skud_object_id,
    k6.period_month,
    SUM(k6.amount) AS ks6_net
  FROM object_ks6_entries k6
  CROSS JOIN params p
  WHERE k6.status = 'signed'
    AND k6.skud_object_id = ANY(p.object_ids)
    -- Полуинтервал по customer_signed_date — по тем же причинам, что в ks2_monthly.
    AND k6.customer_signed_date >= p.month_from
    AND k6.customer_signed_date <  (p.month_to + INTERVAL '1 month')
  GROUP BY k6.skud_object_id, k6.period_month
),
addenda_monthly AS (
  -- «Месяц влияния» ДС: допник от 1-го числа действует весь месяц M и обязан войти
  -- в план M, а фрейм окна исключает текущий месяц. Сдвиг на день решает это без
  -- второго прохода: 01.09 -> 31.08 -> август -> учтён в сентябре;
  --                   20.09 -> 19.09 -> сентябрь -> учтён с октября.
  SELECT
    s.skud_object_id,
    date_trunc('month', (a.effective_date - INTERVAL '1 day')::timestamp)::date AS period_month,
    SUM(a.amount_delta) AS addenda_delta
  FROM object_contract_addenda a
  JOIN scope s ON s.contract_id = a.contract_id
  WHERE a.status = 'signed'
    AND a.effective_date >  (SELECT month_from FROM params)
    AND a.effective_date <= ((SELECT month_to FROM params) + INTERVAL '1 month')
  GROUP BY s.skud_object_id, 2
),
grid AS (
  SELECT s.*, m.period_month
  FROM scope s
  CROSS JOIN months m
  WHERE
    -- Участие объекта (п. 6.1, 6.2): ЗОС внутри месяца -> месяц засчитывается,
    -- следующий уже нет.
    (s.actual_zos_date IS NULL OR s.actual_zos_date >= m.period_month)
    -- Обрезание префикса: договор, начатый позже, не даёт десятки строк с 0 %.
    AND (s.plan_start_month IS NULL OR m.period_month >= s.plan_start_month)
),
running AS (
  SELECT
    g.*,
    b.ks2_before_window,
    b.addenda_before_window,
    COALESCE(km.fact_net, 0::numeric)        AS fact_net,
    COALESCE(km.fact_acts, 0::numeric)       AS fact_acts,
    COALESCE(km.fact_reductions, 0::numeric) AS fact_reductions,
    -- Пустой фрейм даёт NULL, а не 0 -> без COALESCE первый месяц окна провалился бы
    -- в data_incomplete.
    CASE WHEN g.base_amount IS NULL THEN NULL ELSE
      g.base_amount + b.addenda_before_window
      + COALESCE(SUM(COALESCE(am.addenda_delta, 0::numeric)) OVER w, 0::numeric)
    END AS contract_total_calc,
    b.ks2_before_window
      + COALESCE(SUM(COALESCE(km.fact_net, 0::numeric)) OVER w, 0::numeric) AS ks2_cumulative_before_calc,
    COALESCE(k6m.ks6_net, 0::numeric) AS ks6_net,
    -- То же окно w, что у КС-2: своё окно разъехалось бы с ним при обрезании
    -- префикса plan_start_month, и накопительные колонки перестали бы сходиться.
    b.ks6_before_window
      + COALESCE(SUM(COALESCE(k6m.ks6_net, 0::numeric)) OVER w, 0::numeric) AS ks6_cumulative_before_calc
  FROM grid g
  JOIN baselines b       ON b.skud_object_id = g.skud_object_id
  LEFT JOIN ks2_monthly km ON km.skud_object_id = g.skud_object_id AND km.period_month = g.period_month
  LEFT JOIN ks6_monthly k6m ON k6m.skud_object_id = g.skud_object_id AND k6m.period_month = g.period_month
  LEFT JOIN addenda_monthly am ON am.skud_object_id = g.skud_object_id AND am.period_month = g.period_month
  -- RANGE, не ROWS: при обрезании префикса (plan_start_month) или пропуске месяца
  -- ROWS начнёт врать, RANGE — нет. Цена одинаковая.
  WINDOW w AS (
    PARTITION BY g.skud_object_id
    ORDER BY g.period_month
    RANGE BETWEEN UNBOUNDED PRECEDING AND INTERVAL '1 month' PRECEDING
  )
),
calc AS (
  SELECT
    r.*,
    (r.planned_zos_date + INTERVAL '3 months')::date AS control_date_calc,
    -- GREATEST(x, 0) игнорирует NULL: для объекта БЕЗ договора он вернул бы 0
    -- («всё закрыто») вместо «нет данных». Отсюда внешний CASE.
    CASE
      WHEN r.contract_total_calc IS NULL THEN NULL
      ELSE GREATEST(r.contract_total_calc - r.ks2_cumulative_before_calc, 0::numeric)
    END AS remainder_calc
  FROM running r
),
planned AS (
  SELECT
    c.*,
    -- Развёрнутый CASE, а не GREATEST(raw, 1): GREATEST подменил бы случай
    -- «нет плановой ЗОС» единицей и выставил объекту план «весь остаток за месяц»
    -- вместо data_incomplete.
    CASE
      WHEN c.control_date_calc IS NULL THEN NULL
      ELSE GREATEST(
        (EXTRACT(YEAR FROM c.control_date_calc)::int * 12 + EXTRACT(MONTH FROM c.control_date_calc)::int)
        - (EXTRACT(YEAR FROM c.period_month)::int * 12 + EXTRACT(MONTH FROM c.period_month)::int) + 1,
        1
      )
    END AS months_remaining_calc
  FROM calc c
),
computed AS (
  SELECT
    p.*,
    CASE
      WHEN p.remainder_calc IS NULL OR p.months_remaining_calc IS NULL THEN NULL
      -- Та же ROUND(..., 2), что и у снимка в numeric(15,2): иначе plan_drift
      -- ложно срабатывал бы на каждой строке из-за 16-го знака.
      ELSE ROUND(p.remainder_calc / p.months_remaining_calc, 2)
    END AS plan_amount_calc
  FROM planned p
),
-- Снимок подтягивается ОДИН раз. Флаг use_snapshot управляет всей семёркой полей
-- атомарно: поле-за-полем COALESCE после ретро-допника развалил бы тождество
-- remainder / months_remaining = plan_amount прямо в строке отчёта.
final AS (
  SELECT
    c.*,
    mp.id                    AS month_plan_id,
    mp.status                AS stored_plan_status,
    mp.planned_zos_date_used AS snap_planned_zos_date,
    mp.control_date          AS snap_control_date,
    mp.contract_total        AS snap_contract_total,
    mp.ks2_cumulative_before AS snap_ks2_cumulative_before,
    mp.remainder             AS snap_remainder,
    mp.months_remaining      AS snap_months_remaining,
    mp.plan_amount           AS snap_plan_amount,
    mp.override_plan_amount  AS snap_override_plan_amount,
    -- Расчётная половина снимка нужна отдельно от plan_amount: по ней считается
    -- plan_drift. Через plan_amount (= COALESCE(override, calculated)) флаг горел бы
    -- на КАЖДОМ месяце с ручной корректировкой — это и так видно по plan_overridden.
    mp.calculated_plan_amount AS snap_calculated_plan_amount,
    COALESCE(mp.status IN ('fixed','corrected') AND mp.plan_amount IS NOT NULL, false) AS use_snapshot
  FROM computed c
  LEFT JOIN object_kpi_month_plans mp
         ON mp.skud_object_id = c.skud_object_id
        AND mp.period_month   = c.period_month
        AND mp.is_current
)
SELECT
  x.skud_object_id,
  x.object_name,
  x.object_is_active,
  to_char(x.period_month, 'YYYY-MM-DD') AS period_month,
  x.contract_id,
  x.contract_number,
  x.customer_name,
  to_char(x.planned_zos_date, 'YYYY-MM-DD') AS planned_zos_date,
  to_char(x.actual_zos_date,  'YYYY-MM-DD') AS actual_zos_date,

  to_char(CASE WHEN x.use_snapshot THEN x.snap_planned_zos_date     ELSE x.planned_zos_date            END, 'YYYY-MM-DD') AS planned_zos_date_used,
  to_char(CASE WHEN x.use_snapshot THEN x.snap_control_date         ELSE x.control_date_calc           END, 'YYYY-MM-DD') AS control_date,
         (CASE WHEN x.use_snapshot THEN x.snap_contract_total       ELSE x.contract_total_calc         END) AS contract_total,
         (CASE WHEN x.use_snapshot THEN x.snap_ks2_cumulative_before ELSE x.ks2_cumulative_before_calc END) AS ks2_cumulative_before,
         (CASE WHEN x.use_snapshot THEN x.snap_remainder            ELSE x.remainder_calc              END) AS remainder,
         (CASE WHEN x.use_snapshot THEN x.snap_months_remaining     ELSE x.months_remaining_calc       END) AS months_remaining,
         (CASE WHEN x.use_snapshot THEN x.snap_plan_amount          ELSE x.plan_amount_calc            END) AS plan_amount,

  x.plan_amount_calc,
  -- Факт НИКОГДА не берётся из снимка: приказ фиксирует план, а факт по определению
  -- доначисляется задним числом при подписании актов Заказчиком (п. 3.1).
  x.ks2_cumulative_before_calc + x.fact_net AS ks2_cumulative_after,
  -- КС-6 накопительно — пара к ks2_cumulative_after. Из снимка НИКОГДА не берётся:
  -- снимок замораживает план, а КС-6 в плане не участвует вовсе.
  x.ks6_cumulative_before_calc + x.ks6_net AS ks6_cumulative_after,
  x.ks6_net         AS ks6_month_amount,
  x.fact_net        AS fact_amount,
  x.fact_acts,
  x.fact_reductions,

  -- NULLIF(plan, 0) даёт NULL и при fact = 0. UI обязан рисовать «—», а не «0 %»:
  -- иначе полностью закрытый объект выглядел бы провалившим KPI.
  ROUND(
    x.fact_net
    / NULLIF(CASE WHEN x.use_snapshot THEN x.snap_plan_amount ELSE x.plan_amount_calc END, 0)
    * 100,
    2
  ) AS completion_pct,

  CASE WHEN x.use_snapshot THEN 'snapshot' ELSE 'calculated' END AS plan_source,
  (x.snap_override_plan_amount IS NOT NULL)                      AS plan_overridden,
  -- «После фиксации в исходные данные месяца что-то заехало» (аудит п. 2.8).
  -- Сравнивается РАСЧЁТНАЯ половина снимка с текущим расчётом: ручная корректировка —
  -- это не дрейф данных, для неё есть plan_overridden.
  -- IS DISTINCT FROM, а не <>: иначе NULL-случай не детектится.
  (x.use_snapshot AND x.snap_calculated_plan_amount IS DISTINCT FROM x.plan_amount_calc) AS plan_drift,

  -- Приоритет «снимок -> data_incomplete -> open»: если после фиксации у объекта
  -- затёрли planned_zos_date, зафиксированный план стирать нельзя — он валиден
  -- вместе со своим planned_zos_date_used.
  CASE
    WHEN x.use_snapshot THEN x.stored_plan_status
    WHEN x.contract_id IS NULL OR x.base_amount IS NULL OR x.planned_zos_date IS NULL THEN 'data_incomplete'
    ELSE 'open'
  END AS report_status,

  CASE
    WHEN x.contract_id IS NULL      THEN 'no_active_contract'
    WHEN x.base_amount IS NULL      THEN 'no_base_amount'
    WHEN x.planned_zos_date IS NULL THEN 'no_planned_zos_date'
    ELSE 'ok'
  END AS data_quality,

  COALESCE(x.contract_total_calc < x.ks2_cumulative_before_calc, false) AS over_contract,
  COALESCE(x.control_date_calc < x.period_month, false)                 AS is_overdue,

  x.month_plan_id,
  x.stored_plan_status,

  COALESCE(mgr.managers, '[]'::jsonb) AS managers,
  mgr.primary_manager_id,
  mgr.primary_manager_name
FROM final x
LEFT JOIN LATERAL (
  -- Руководители месяца + число дней пересечения периода закрепления с месяцем.
  -- Дни нужны Этапу 2 для пропорции при смене руководителя (п. 6.4); в Этапе 1
  -- просто отображаются.
  SELECT
    jsonb_agg(jsonb_build_object(
      'employee_id', t.employee_id,
      'full_name',   t.full_name,
      'days',        t.days
    ) ORDER BY t.days DESC) AS managers,
    (array_agg(t.employee_id ORDER BY t.days DESC))[1] AS primary_manager_id,
    (array_agg(t.full_name   ORDER BY t.days DESC))[1] AS primary_manager_name
  FROM (
    SELECT
      a.employee_id,
      e.full_name,
      (LEAST(COALESCE(a.valid_to, 'infinity'::date),
             (x.period_month + INTERVAL '1 month' - INTERVAL '1 day')::date)
       - GREATEST(a.valid_from, x.period_month) + 1) AS days
    FROM object_kpi_assignments a
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.skud_object_id = x.skud_object_id
      AND a.role_kind = 'construction_manager'
      AND a.valid_from <= (x.period_month + INTERVAL '1 month' - INTERVAL '1 day')::date
      AND (a.valid_to IS NULL OR a.valid_to >= x.period_month)
  ) t
) mgr ON true
ORDER BY x.object_name, x.period_month
`;

export interface ObjectKpiReportParams {
  monthFrom: string;   // YYYY-MM-01
  monthTo: string;     // YYYY-MM-01
  objectIds: string[];
}

export async function fetchObjectKpiReport(
  params: ObjectKpiReportParams,
): Promise<ObjectKpiReportRow[]> {
  // = ANY('{}'::uuid[]) возвращает 0 строк без ошибки, в отличие от IN () —
  // отдельная ветка «если скоуп пуст» не нужна.
  return query<ObjectKpiReportRow>(OBJECT_KPI_REPORT_SQL, [
    params.monthFrom,
    params.monthTo,
    params.objectIds,
  ]);
}

/**
 * Сводка по руководителю за период (п. 3.5): Σfact / Σplan, а НЕ среднее процентов.
 * Разница на реальных данных доходит до десятков процентных пунктов.
 *
 * Строки data_incomplete исключаются из обеих сумм: план там NULL, и подстановка
 * нуля занизила бы процент за месяцы, где данных просто не было.
 */
export function summarizeCompletion(rows: ObjectKpiReportRow[]): {
  total_plan: number;
  total_fact: number;
  completion_pct: number | null;
} {
  let totalPlan = 0;
  let totalFact = 0;

  for (const row of rows) {
    if (row.plan_amount === null) continue;
    totalPlan += Number(row.plan_amount);
    totalFact += Number(row.fact_amount);
  }

  return {
    total_plan: Number(totalPlan.toFixed(2)),
    total_fact: Number(totalFact.toFixed(2)),
    completion_pct: totalPlan === 0 ? null : Number(((totalFact / totalPlan) * 100).toFixed(2)),
  };
}
