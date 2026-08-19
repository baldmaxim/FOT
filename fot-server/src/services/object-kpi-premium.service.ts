import type { PoolClient } from 'pg';

import { withTransaction } from '../config/postgres.js';
import { OBJECT_KPI_REPORT_SQL, type ObjectKpiReportRow } from './object-kpi-report.service.js';

/**
 * Премия KPI закрытия КС-2 для руководителя строительства — ПРЕДВАРИТЕЛЬНЫЙ расчёт.
 *
 * Приказ, п. 4:
 *   доля(объект, M) = мои_дни / Σ дней всех руководителей объекта в M            (п. 6.4)
 *   Σплан(M)  = Σ plan_amount × доля      — БЕЗ промежуточного округления
 *   Σфакт(M)  = Σ fact_amount × доля
 *   X         = ROUND(Σфакт / NULLIF(Σплан,0) × 100, 2)                          (п. 3.4, 3.5)
 *   K         = ROUND(K₁ + (X−X₁)/(X₂−X₁) × (K₂−K₁), 2); X ≤ мин → 0, X ≥ макс → макс (п. 4.3–4.4)
 *   база(M)   = ROUND(base_amount × eligible_дни / дней_в_месяце, 2)             (п. 4.6)
 *   премия(M) = ROUND(база × K)  — целые рубли
 *
 * Три вещи, каждая из которых при небрежности даёт молча неверные деньги:
 *
 * 1. ТОЧКИ ИНТЕРПОЛЯЦИИ ищутся асимметрично: нижняя `completion_pct <= X`, верхняя
 *    `completion_pct > X`. При симметричных `<=` / `>=` точное попадание в точку шкалы
 *    (X = 95) дало бы X₁ = X₂ и деление на ноль. NULLIF(x2-x1,0) остаётся страховкой.
 * 2. ОКРУГЛЕНИЕ ОДИН РАЗ: доли складываются неокруглёнными, ROUND(…,2) применяется к
 *    месячным суммам и базе, ROUND(…,0) — к премии. Иначе копейки долей накапливаются.
 * 3. ДВА СЧЁТЧИКА ДНЕЙ: any_assignment_days отличает «не был закреплён» от «план не
 *    определён», eligible_assignment_days (объекты с определённым планом) идёт в базу.
 *
 * Устройство запросов. Q1/Q2 читают таблицы, Q3/Q4 — ЧИСТАЯ АРИФМЕТИКА над jsonb, без
 * единого обращения к таблицам. Это сделано ради тестируемости: денежные формулы можно
 * прогонять на любом PostgreSQL (в т.ч. read-only) без создания схемы и данных.
 * Всё выполняется в ОДНОЙ транзакции REPEATABLE READ READ ONLY: между чтением отчёта и
 * чтением закреплений состав закреплений иначе успевает измениться, и премия посчиталась
 * бы по другому составу, чем показанная рядом таблица.
 */

export type PremiumMonthStatus =
  | 'no_scale'
  | 'not_assigned'
  | 'data_incomplete'
  | 'no_plan'
  | 'calculated';

export interface ObjectKpiReportRowWithShare extends ObjectKpiReportRow {
  /** Дней в месяце, за которые объект был закреплён за этим руководителем. */
  my_days: number;
  /** Сумма дней всех руководителей объекта в этом месяце (знаменатель доли, п. 6.4). */
  total_days: number;
  my_share_pct: string | null;
  /** Доля руководителя, округлённая до копеек — для показа. */
  my_plan_amount: string | null;
  my_fact_amount: string | null;
  included_in_premium: boolean;
  exclusion_reason: 'not_assigned' | 'no_plan' | null;
}

export interface PremiumMonthObject {
  skud_object_id: string;
  object_name: string;
  my_days: number;
  total_days: number;
  my_share_pct: string | null;
  my_plan_amount: string | null;
  my_fact_amount: string | null;
  included_in_premium: boolean;
  exclusion_reason: 'not_assigned' | 'no_plan' | null;
  data_quality: ObjectKpiReportRow['data_quality'];
}

export interface ManagerPremiumMonth {
  period_month: string;
  status: PremiumMonthStatus;
  total_plan: string | null;
  total_fact: string | null;
  completion_pct: string | null;
  coefficient: string | null;
  interpolation: {
    lower_pct: string | null;
    lower_coef: string | null;
    upper_pct: string | null;
    upper_coef: string | null;
  } | null;
  scale_version_id: string | null;
  base_amount: string | null;
  any_assignment_days: number;
  eligible_assignment_days: number;
  days_in_month: number;
  base_prorated: string | null;
  premium_amount: string | null;
  objects: PremiumMonthObject[];
  incomplete_objects: Array<{ object_name: string; data_quality: ObjectKpiReportRow['data_quality'] }>;
}

export interface PremiumPeriodTotals {
  total_plan: string;
  total_fact: string;
  completion_pct: string | null;
  total_premium: string;
}

export interface PremiumScaleVersion {
  id: string;
  valid_from: string;
  base_amount: string;
  max_premium: string | null;
  order_reference: string | null;
  order_url: string | null;
  points: Array<{ completion_pct: string; coefficient: string; premium_amount: string }>;
}

export interface ManagerPremiumResult {
  rows: ObjectKpiReportRowWithShare[];
  premium: ManagerPremiumMonth[];
  period_totals: PremiumPeriodTotals;
  scales: PremiumScaleVersion[];
}

/** Q0 — версии шкалы, которые вообще могут действовать внутри окна. */
const SCALE_VERSIONS_SQL = `
SELECT
  v.id,
  to_char(v.valid_from, 'YYYY-MM-DD') AS valid_from,
  v.base_amount,
  v.order_reference,
  v.order_url,
  -- Максимум по шкале не хранится колонкой: он производная от точек и базы.
  (SELECT MAX(p.coefficient) FROM kpi_premium_scale_points p WHERE p.version_id = v.id)
    * v.base_amount AS max_premium,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'completion_pct', p.completion_pct::text,
             'coefficient',    p.coefficient::text,
             -- Премия точки считается здесь, а не на фронте: деньги считает SQL.
             'premium_amount', ROUND(p.coefficient * v.base_amount)::text
           ) ORDER BY p.completion_pct)
      FROM kpi_premium_scale_points p
     WHERE p.version_id = v.id
  ), '[]'::jsonb) AS points
FROM kpi_premium_scale_versions v
WHERE v.valid_from <= date_trunc('month', $1::date::timestamp)::date
ORDER BY v.valid_from
`;

/**
 * Q1 — тот же отчёт, что уходит в таблицу экрана, плюс доля руководителя на каждой строке.
 *
 * Доля считается ЗДЕСЬ, а не на фронте: денежная арифметика в JS запрещена (numeric
 * приходит строкой, «+» склеил бы строки), а UI обязан получать готовые числа.
 */
export const REPORT_WITH_SHARES_SQL = `
WITH report AS (
${OBJECT_KPI_REPORT_SQL}
)
SELECT
  r.*,
  COALESCE(mine.my_days, 0)    AS my_days,
  COALESCE(total.total_days, 0) AS total_days,
  CASE
    WHEN COALESCE(total.total_days, 0) = 0 THEN NULL
    ELSE ROUND(COALESCE(mine.my_days, 0)::numeric / total.total_days * 100, 2)
  END AS my_share_pct,
  CASE
    WHEN r.plan_amount IS NULL OR COALESCE(total.total_days, 0) = 0 THEN NULL
    ELSE ROUND(r.plan_amount * COALESCE(mine.my_days, 0) / total.total_days, 2)
  END AS my_plan_amount,
  CASE
    WHEN COALESCE(total.total_days, 0) = 0 THEN NULL
    ELSE ROUND(r.fact_amount * COALESCE(mine.my_days, 0) / total.total_days, 2)
  END AS my_fact_amount,
  -- Неокруглённые доли — вход месячных сумм. Округление один раз, на агрегате.
  CASE
    WHEN r.plan_amount IS NULL OR COALESCE(total.total_days, 0) = 0 THEN NULL
    ELSE r.plan_amount * COALESCE(mine.my_days, 0) / total.total_days
  END AS my_plan_exact,
  CASE
    WHEN COALESCE(total.total_days, 0) = 0 THEN NULL
    ELSE r.fact_amount * COALESCE(mine.my_days, 0) / total.total_days
  END AS my_fact_exact,
  (COALESCE(mine.my_days, 0) > 0 AND r.plan_amount IS NOT NULL) AS included_in_premium,
  CASE
    WHEN COALESCE(mine.my_days, 0) = 0 THEN 'not_assigned'
    WHEN r.plan_amount IS NULL        THEN 'no_plan'
    ELSE NULL
  END AS exclusion_reason
FROM report r
LEFT JOIN LATERAL (
  SELECT (x->>'days')::int AS my_days
    FROM jsonb_array_elements(r.managers) x
   WHERE (x->>'employee_id')::bigint = $4::bigint
   LIMIT 1
) mine ON true
LEFT JOIN LATERAL (
  SELECT SUM((x->>'days')::int) AS total_days
    FROM jsonb_array_elements(r.managers) x
) total ON true
`;

/** Q2 — периоды закреплений руководителя, пересекающиеся с окном. */
const ASSIGNMENT_PERIODS_SQL = `
SELECT
  skud_object_id,
  to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
  to_char(valid_to,   'YYYY-MM-DD') AS valid_to
FROM object_kpi_assignments
WHERE employee_id = $1::bigint
  AND role_kind = 'construction_manager'
  AND valid_from < ($3::date + INTERVAL '1 month')
  AND (valid_to IS NULL OR valid_to >= $2::date)
`;

/**
 * Q3 — дни закрепления по месяцам. ЧИСТАЯ функция: таблиц не читает.
 *
 * $1 monthFrom, $2 monthTo, $3 периоды закреплений, $4 «объект участвует в месяце»
 * (строки отчёта с определённым планом).
 */
export const PREMIUM_ASSIGNMENT_DAYS_SQL = `
WITH months AS (
  SELECT generate_series($1::date::timestamp, $2::date::timestamp, INTERVAL '1 month')::date AS period_month
),
days AS (
  SELECT m.period_month, d::date AS day
    FROM months m
    CROSS JOIN LATERAL generate_series(
      m.period_month::timestamp,
      (m.period_month + INTERVAL '1 month' - INTERVAL '1 day')::timestamp,
      INTERVAL '1 day'
    ) d
),
asg AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS a(skud_object_id uuid, valid_from date, valid_to date)
),
elig AS (
  SELECT * FROM jsonb_to_recordset($4::jsonb) AS e(period_month date, skud_object_id uuid)
)
SELECT
  to_char(d.period_month, 'YYYY-MM-DD') AS period_month,
  COUNT(*)::int AS days_in_month,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM asg a
     WHERE d.day >= a.valid_from
       AND (a.valid_to IS NULL OR d.day <= a.valid_to)
  ))::int AS any_assignment_days,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM asg a
      JOIN elig e ON e.skud_object_id = a.skud_object_id AND e.period_month = d.period_month
     WHERE d.day >= a.valid_from
       AND (a.valid_to IS NULL OR d.day <= a.valid_to)
  ))::int AS eligible_assignment_days
FROM days d
GROUP BY d.period_month
ORDER BY d.period_month
`;

/**
 * Q4 — выполнение → коэффициент → база → премия. ЧИСТАЯ функция: таблиц не читает.
 *
 * $1 месяцы, $2 доли по объектам, $3 точки шкалы. Суммирование долей и итоги за период
 * считаются здесь же: денежная арифметика в JS запрещена (numeric приходит строкой).
 */
export const PREMIUM_MATH_SQL = `
WITH meta AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
    period_month     date,
    any_days         int,
    eligible_days    int,
    days_in_month    int,
    has_incomplete   boolean,
    scale_version_id uuid,
    base_amount      numeric
  )
),
shares AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS t(
    period_month date,
    plan_exact   numeric,
    fact_exact   numeric
  )
),
agg AS (
  SELECT period_month, SUM(plan_exact) AS total_plan, SUM(fact_exact) AS total_fact
    FROM shares
   GROUP BY period_month
),
m AS (
  SELECT meta.*, agg.total_plan, agg.total_fact
    FROM meta
    LEFT JOIN agg ON agg.period_month = meta.period_month
),
p AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS t(
    version_id     uuid,
    completion_pct numeric,
    coefficient    numeric
  )
),
x AS (
  SELECT
    m.*,
    ROUND(m.total_plan, 2) AS plan_rounded,
    ROUND(m.total_fact, 2) AS fact_rounded,
    -- NULLIF(plan,0) даёт NULL и при нулевом факте: полностью закрытый объект не должен
    -- выглядеть провалившим KPI, UI рисует «—», а не «0 %».
    ROUND(m.total_fact / NULLIF(m.total_plan, 0) * 100, 2) AS completion_pct
  FROM m
),
bounds AS (
  SELECT
    x.*,
    lo.completion_pct AS lower_pct,
    lo.coefficient    AS lower_coef,
    hi.completion_pct AS upper_pct,
    hi.coefficient    AS upper_coef
  FROM x
  -- Нижняя точка <= X, верхняя строго > X. Симметричные <= / >= дали бы X1 = X2 при
  -- точном попадании в точку шкалы и деление на ноль.
  LEFT JOIN LATERAL (
    SELECT p.completion_pct, p.coefficient
      FROM p
     WHERE p.version_id = x.scale_version_id
       AND p.completion_pct <= x.completion_pct
     ORDER BY p.completion_pct DESC
     LIMIT 1
  ) lo ON x.completion_pct IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT p.completion_pct, p.coefficient
      FROM p
     WHERE p.version_id = x.scale_version_id
       AND p.completion_pct > x.completion_pct
     ORDER BY p.completion_pct
     LIMIT 1
  ) hi ON x.completion_pct IS NOT NULL
),
staged AS (
  SELECT
    b.*,
    CASE
      WHEN b.scale_version_id IS NULL                     THEN 'no_scale'
      WHEN COALESCE(b.any_days, 0) = 0                    THEN 'not_assigned'
      WHEN b.has_incomplete                               THEN 'data_incomplete'
      WHEN b.plan_rounded IS NULL OR b.plan_rounded = 0   THEN 'no_plan'
      ELSE 'calculated'
    END AS status
  FROM bounds b
),
scored AS (
  SELECT
    s.*,
    CASE
      WHEN s.status <> 'calculated' THEN NULL
      WHEN s.lower_pct IS NULL      THEN 0.00::numeric        -- ниже минимальной точки (п. 4.4)
      WHEN s.upper_pct IS NULL      THEN s.lower_coef          -- на максимуме шкалы и выше
      ELSE ROUND(
        s.lower_coef
        + (s.completion_pct - s.lower_pct) / NULLIF(s.upper_pct - s.lower_pct, 0)
          * (s.upper_coef - s.lower_coef),
        2)
    END AS coefficient,
    CASE
      WHEN s.status <> 'calculated' OR s.days_in_month IS NULL OR s.days_in_month = 0 THEN NULL
      ELSE ROUND(s.base_amount * COALESCE(s.eligible_days, 0) / s.days_in_month, 2)
    END AS base_prorated
  FROM staged s
),
final AS (
  SELECT
    sc.*,
    CASE
      WHEN sc.coefficient IS NULL OR sc.base_prorated IS NULL THEN NULL
      ELSE ROUND(sc.base_prorated * sc.coefficient, 0)
    END AS premium_amount
  FROM scored sc
)
SELECT
  to_char(f.period_month, 'YYYY-MM-DD') AS period_month,
  f.status,
  f.plan_rounded   AS total_plan,
  f.fact_rounded   AS total_fact,
  f.completion_pct,
  f.coefficient,
  f.lower_pct, f.lower_coef, f.upper_pct, f.upper_coef,
  f.scale_version_id,
  f.base_amount,
  COALESCE(f.any_days, 0)      AS any_assignment_days,
  COALESCE(f.eligible_days, 0) AS eligible_assignment_days,
  f.days_in_month,
  f.base_prorated,
  f.premium_amount,
  -- Итоги периода: только месяцы, по которым расчёт состоялся. Месяцы вне закрепления
  -- и без данных в знаменатель не попадают — иначе процент за период занижается.
  ROUND(COALESCE(SUM(f.plan_rounded) FILTER (WHERE f.status = 'calculated') OVER (), 0), 2) AS period_total_plan,
  ROUND(COALESCE(SUM(f.fact_rounded) FILTER (WHERE f.status = 'calculated') OVER (), 0), 2) AS period_total_fact,
  ROUND(COALESCE(SUM(f.premium_amount) OVER (), 0), 0) AS period_total_premium,
  ROUND(
    SUM(f.fact_rounded) FILTER (WHERE f.status = 'calculated') OVER ()
    / NULLIF(SUM(f.plan_rounded) FILTER (WHERE f.status = 'calculated') OVER (), 0)
    * 100,
    2) AS period_completion_pct
FROM final f
ORDER BY f.period_month
`;

interface ShareRow extends ObjectKpiReportRowWithShare {
  my_plan_exact: string | null;
  my_fact_exact: string | null;
}

interface DaysRow {
  period_month: string;
  days_in_month: number;
  any_assignment_days: number;
  eligible_assignment_days: number;
}

interface MathRow {
  period_month: string;
  status: PremiumMonthStatus;
  total_plan: string | null;
  total_fact: string | null;
  completion_pct: string | null;
  coefficient: string | null;
  lower_pct: string | null;
  lower_coef: string | null;
  upper_pct: string | null;
  upper_coef: string | null;
  scale_version_id: string | null;
  base_amount: string | null;
  any_assignment_days: number;
  eligible_assignment_days: number;
  days_in_month: number;
  base_prorated: string | null;
  premium_amount: string | null;
  period_total_plan: string;
  period_total_fact: string;
  period_total_premium: string;
  period_completion_pct: string | null;
}

export const EMPTY_PREMIUM_TOTALS: PremiumPeriodTotals = {
  total_plan: '0.00',
  total_fact: '0.00',
  completion_pct: null,
  total_premium: '0',
};

/** Версия шкалы, действующая на месяц: последняя, начавшаяся не позже него (п. 8.3). */
export function pickScaleVersion(
  scales: PremiumScaleVersion[],
  periodMonth: string,
): PremiumScaleVersion | null {
  let picked: PremiumScaleVersion | null = null;
  for (const scale of scales) {
    if (scale.valid_from <= periodMonth) picked = scale;
  }
  return picked;
}

export interface ManagerPremiumParams {
  employeeId: number;
  objectIds: string[];
  monthFrom: string;   // YYYY-MM-01
  monthTo: string;     // YYYY-MM-01
}

export async function fetchManagerPremium(
  params: ManagerPremiumParams,
): Promise<ManagerPremiumResult> {
  return withTransaction(async (client: PoolClient) => {
    // Один снимок на все запросы: иначе состав закреплений меняется между чтениями и
    // премия считается по другому составу, чем показанная таблица.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');

    const scales = await loadScales(client, params.monthTo);
    const shareRows = await loadRowsWithShares(client, params);
    const days = await loadAssignmentDays(client, params, shareRows);
    const premium = await computePremium(client, shareRows, days, scales);

    const rows: ObjectKpiReportRowWithShare[] = shareRows.map(
      ({ my_plan_exact: _plan, my_fact_exact: _fact, ...row }) => row,
    );

    return {
      rows,
      premium: premium.months,
      period_totals: premium.totals,
      // Наружу отдаём только версии, которые реально применены хотя бы к одному месяцу.
      scales: scales.filter((scale) =>
        premium.months.some((month) => month.scale_version_id === scale.id)),
    };
  });
}

async function loadScales(client: PoolClient, monthTo: string): Promise<PremiumScaleVersion[]> {
  const result = await client.query<PremiumScaleVersion>(SCALE_VERSIONS_SQL, [monthTo]);
  return result.rows;
}

async function loadRowsWithShares(
  client: PoolClient,
  params: ManagerPremiumParams,
): Promise<ShareRow[]> {
  const result = await client.query<ShareRow>(REPORT_WITH_SHARES_SQL, [
    params.monthFrom,
    params.monthTo,
    params.objectIds,
    params.employeeId,
  ]);
  return result.rows;
}

async function loadAssignmentDays(
  client: PoolClient,
  params: ManagerPremiumParams,
  rows: ShareRow[],
): Promise<Map<string, DaysRow>> {
  const periods = await client.query<{ skud_object_id: string; valid_from: string; valid_to: string | null }>(
    ASSIGNMENT_PERIODS_SQL,
    [params.employeeId, params.monthFrom, params.monthTo],
  );

  // «Участвует в месяце» = строка отчёта с определённым планом. Объект без договора или
  // без плановой ЗОС в пропорцию базы не входит — иначе база режется по дням объекта,
  // который в расчёте всё равно не участвует.
  const eligible = rows
    .filter((row) => row.plan_amount !== null)
    .map((row) => ({ period_month: row.period_month, skud_object_id: row.skud_object_id }));

  const result = await client.query<DaysRow>(PREMIUM_ASSIGNMENT_DAYS_SQL, [
    params.monthFrom,
    params.monthTo,
    JSON.stringify(periods.rows),
    JSON.stringify(eligible),
  ]);

  return new Map(result.rows.map((row) => [row.period_month, row]));
}

async function computePremium(
  client: PoolClient,
  rows: ShareRow[],
  days: Map<string, DaysRow>,
  scales: PremiumScaleVersion[],
): Promise<{ months: ManagerPremiumMonth[]; totals: PremiumPeriodTotals }> {
  const byMonth = new Map<string, ShareRow[]>();
  for (const row of rows) {
    const bucket = byMonth.get(row.period_month);
    if (bucket) bucket.push(row);
    else byMonth.set(row.period_month, [row]);
  }

  // Решётка месяцев берётся из дней (Q3 её и строит), а не из строк отчёта: месяц без
  // единого объекта обязан остаться в выдаче со статусом, а не исчезнуть.
  const months = [...days.keys()].sort();

  const input = months.map((month) => {
    const monthRows = byMonth.get(month) ?? [];
    const dayRow = days.get(month);
    const scale = pickScaleVersion(scales, month);

    return {
      period_month: month,
      any_days: dayRow?.any_assignment_days ?? 0,
      eligible_days: dayRow?.eligible_assignment_days ?? 0,
      days_in_month: dayRow?.days_in_month ?? 0,
      has_incomplete: monthRows.some((row) => row.my_days > 0 && row.plan_amount === null),
      scale_version_id: scale?.id ?? null,
      base_amount: scale?.base_amount ?? null,
    };
  });

  // Доли уходят в SQL как есть — суммирует их PostgreSQL на numeric.
  const shares = rows
    .filter((row) => row.included_in_premium)
    .map((row) => ({
      period_month: row.period_month,
      plan_exact: row.my_plan_exact,
      fact_exact: row.my_fact_exact,
    }));

  const scalePoints = scales.flatMap((scale) =>
    scale.points.map((point) => ({
      version_id: scale.id,
      completion_pct: point.completion_pct,
      coefficient: point.coefficient,
    })));

  if (input.length === 0) return { months: [], totals: EMPTY_PREMIUM_TOTALS };

  const result = await client.query<MathRow>(PREMIUM_MATH_SQL, [
    JSON.stringify(input),
    JSON.stringify(shares),
    JSON.stringify(scalePoints),
  ]);

  const monthsOut: ManagerPremiumMonth[] = result.rows.map((row) => {
    const monthRows = byMonth.get(row.period_month) ?? [];
    return {
      period_month: row.period_month,
      status: row.status,
      total_plan: row.total_plan,
      total_fact: row.total_fact,
      completion_pct: row.completion_pct,
      coefficient: row.coefficient,
      interpolation: row.status === 'calculated'
        ? {
          lower_pct: row.lower_pct,
          lower_coef: row.lower_coef,
          upper_pct: row.upper_pct,
          upper_coef: row.upper_coef,
        }
        : null,
      scale_version_id: row.scale_version_id,
      base_amount: row.base_amount,
      any_assignment_days: row.any_assignment_days,
      eligible_assignment_days: row.eligible_assignment_days,
      days_in_month: row.days_in_month,
      base_prorated: row.base_prorated,
      premium_amount: row.premium_amount,
      objects: monthRows
        .filter((item) => item.my_days > 0)
        .map((item) => ({
          skud_object_id: item.skud_object_id,
          object_name: item.object_name,
          my_days: item.my_days,
          total_days: item.total_days,
          my_share_pct: item.my_share_pct,
          my_plan_amount: item.my_plan_amount,
          my_fact_amount: item.my_fact_amount,
          included_in_premium: item.included_in_premium,
          exclusion_reason: item.exclusion_reason,
          data_quality: item.data_quality,
        })),
      incomplete_objects: monthRows
        .filter((item) => item.my_days > 0 && item.plan_amount === null)
        .map((item) => ({ object_name: item.object_name, data_quality: item.data_quality })),
    };
  });

  const first = result.rows[0];
  return {
    months: monthsOut,
    totals: first
      ? {
        total_plan: first.period_total_plan,
        total_fact: first.period_total_fact,
        completion_pct: first.period_completion_pct,
        total_premium: first.period_total_premium,
      }
      : EMPTY_PREMIUM_TOTALS,
  };
}
