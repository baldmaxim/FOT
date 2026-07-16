-- Сравнение: tariff_fee vs services vs charges_amount vs statement_rows
-- для номеров с привязкой к ФОТ без связи.
WITH fee_snap AS (
  SELECT DISTINCT ON (msisdn_hash)
         msisdn_hash, (payload->>'amount')::numeric AS fee_amount
    FROM mts_business_metric_snapshot
   WHERE scope = 'msisdn' AND metric = 'tariff_fee' AND msisdn_hash IS NOT NULL
   ORDER BY msisdn_hash, captured_at DESC
),
services_snap AS (
  SELECT DISTINCT ON (msisdn_hash) msisdn_hash, payload AS product_services
    FROM mts_business_metric_snapshot
   WHERE scope = 'msisdn' AND metric = 'product_services' AND msisdn_hash IS NOT NULL
   ORDER BY msisdn_hash, captured_at DESC
),
services_sum AS (
  SELECT s.msisdn_hash,
         COALESCE((
           SELECT SUM(COALESCE((x->>'monthlyAmount')::numeric, 0))
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.product_services) = 'array'
                    THEN s.product_services ELSE '[]'::jsonb END
             ) AS x
         ), 0) AS services_monthly
    FROM services_snap s
),
usage AS (
  SELECT msisdn_hash,
         COUNT(*) FILTER (WHERE category IN ('calls','sms','internet')) AS usage_events,
         COALESCE(SUM(amount) FILTER (WHERE category = 'periodic'), 0) AS stmt_periodic,
         COALESCE(SUM(amount) FILTER (WHERE category NOT IN ('topups')), 0) AS stmt_all_expense,
         COALESCE(SUM(amount) FILTER (WHERE category IN ('periodic','oneTime','other')), 0) AS stmt_non_usage
    FROM mts_business_statement_rows
   GROUP BY msisdn_hash
),
cdr AS (
  SELECT msisdn_hash, calls FROM mts_business_cdr_rollup
),
charges_cur AS (
  SELECT msisdn_hash, SUM(amount) AS charges_mtd
    FROM mts_business_metric_daily
   WHERE scope = 'msisdn' AND metric = 'charges_amount' AND msisdn_hash IS NOT NULL
     AND captured_date >= date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow'))::date
   GROUP BY msisdn_hash
),
charges_prev AS (
  SELECT msisdn_hash, SUM(amount) AS charges_prev
    FROM mts_business_metric_daily
   WHERE scope = 'msisdn' AND metric = 'charges_amount' AND msisdn_hash IS NOT NULL
     AND captured_date >= (date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow')) - INTERVAL '1 month')::date
     AND captured_date < date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow'))::date
   GROUP BY msisdn_hash
),
base AS (
  SELECT nm.msisdn_hash,
         COALESCE(f.fee_amount, 0) AS fee,
         COALESCE(ss.services_monthly, 0) AS services,
         COALESCE(ch.charges_mtd, 0) AS charges_mtd,
         COALESCE(cp.charges_prev, 0) AS charges_prev,
         COALESCE(u.stmt_periodic, 0) AS stmt_periodic,
         COALESCE(u.stmt_all_expense, 0) AS stmt_all,
         COALESCE(u.stmt_non_usage, 0) AS stmt_non_usage
    FROM mts_business_number_map nm
   INNER JOIN employees e ON e.id = nm.employee_id
    LEFT JOIN fee_snap f ON f.msisdn_hash = nm.msisdn_hash
    LEFT JOIN services_sum ss ON ss.msisdn_hash = nm.msisdn_hash
    LEFT JOIN usage u ON u.msisdn_hash = nm.msisdn_hash
    LEFT JOIN cdr c ON c.msisdn_hash = nm.msisdn_hash
    LEFT JOIN charges_cur ch ON ch.msisdn_hash = nm.msisdn_hash
    LEFT JOIN charges_prev cp ON cp.msisdn_hash = nm.msisdn_hash
   WHERE COALESCE(f.fee_amount, 0) > 0
     AND COALESCE(c.calls, 0) = 0
     AND COALESCE(u.usage_events, 0) = 0
)
SELECT
  COUNT(*) AS n,
  ROUND(SUM(fee), 2) AS sum_fee,
  ROUND(SUM(services), 2) AS sum_services,
  ROUND(SUM(fee + services), 2) AS sum_fee_plus_services,
  ROUND(SUM(charges_mtd), 2) AS sum_charges_mtd,
  ROUND(SUM(charges_prev), 2) AS sum_charges_prev_month,
  ROUND(SUM(stmt_periodic), 2) AS sum_stmt_periodic,
  ROUND(SUM(stmt_non_usage), 2) AS sum_stmt_non_usage,
  ROUND(SUM(stmt_all), 2) AS sum_stmt_all_expense,
  COUNT(*) FILTER (WHERE charges_mtd > 0) AS n_with_charges_mtd,
  COUNT(*) FILTER (WHERE charges_prev > 0) AS n_with_charges_prev,
  COUNT(*) FILTER (WHERE stmt_periodic > 0) AS n_with_stmt_periodic,
  COUNT(*) FILTER (WHERE stmt_all > 0) AS n_with_stmt_any
FROM base;
