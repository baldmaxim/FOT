-- Полнота выписки vs charges для неиспользуемых SIM сотрудников ФОТ.
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
         ), 0) AS services_monthly,
         COALESCE((
           SELECT SUM(COALESCE((x->>'monthlyAmount')::numeric, 0))
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.product_services) = 'array'
                    THEN s.product_services ELSE '[]'::jsonb END
             ) AS x
            WHERE COALESCE(x->>'name','') ~* 'Ежемесячная плата'
         ), 0) AS services_monthly_fee_like
    FROM services_snap s
),
usage AS (
  SELECT msisdn_hash,
         COUNT(*) FILTER (WHERE category IN ('calls','sms','internet')) AS usage_events,
         COUNT(*) AS stmt_rows,
         MIN(usage_date) AS stmt_from,
         MAX(usage_date) AS stmt_to,
         COALESCE(SUM(amount) FILTER (WHERE category NOT IN ('topups')), 0) AS stmt_all,
         COALESCE(SUM(amount) FILTER (
           WHERE category NOT IN ('topups')
             AND usage_date >= date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow'))::date
         ), 0) AS stmt_mtd
    FROM mts_business_statement_rows
   GROUP BY msisdn_hash
),
cdr AS (SELECT msisdn_hash, calls FROM mts_business_cdr_rollup),
base AS (
  SELECT
    nm.msisdn_hash,
    e.full_name,
    nm.statement_synced_at,
    nm.last_usage_at,
    COALESCE(f.fee_amount, 0) AS fee,
    COALESCE(ss.services_monthly, 0) AS services,
    COALESCE(ss.services_monthly_fee_like, 0) AS services_fee_like,
    COALESCE(u.usage_events, 0) AS usage_events,
    COALESCE(u.stmt_rows, 0) AS stmt_rows,
    u.stmt_from, u.stmt_to,
    COALESCE(u.stmt_all, 0) AS stmt_all,
    COALESCE(u.stmt_mtd, 0) AS stmt_mtd
  FROM mts_business_number_map nm
  INNER JOIN employees e ON e.id = nm.employee_id
  LEFT JOIN fee_snap f ON f.msisdn_hash = nm.msisdn_hash
  LEFT JOIN services_sum ss ON ss.msisdn_hash = nm.msisdn_hash
  LEFT JOIN usage u ON u.msisdn_hash = nm.msisdn_hash
  LEFT JOIN cdr c ON c.msisdn_hash = nm.msisdn_hash
  WHERE COALESCE(f.fee_amount, 0) > 0
    AND COALESCE(c.calls, 0) = 0
    AND COALESCE(u.usage_events, 0) = 0
)
SELECT
  COUNT(*) AS n,
  ROUND(SUM(fee),2) AS sum_fee_snap,
  ROUND(SUM(services),2) AS sum_services_all,
  ROUND(SUM(services_fee_like),2) AS sum_services_fee_like,
  ROUND(SUM(GREATEST(fee, services)),2) AS sum_max_fee_or_services,
  ROUND(SUM(stmt_mtd),2) AS sum_stmt_mtd,
  ROUND(SUM(stmt_all),2) AS sum_stmt_all_time,
  COUNT(*) FILTER (WHERE stmt_rows = 0) AS n_no_statement_rows,
  COUNT(*) FILTER (WHERE statement_synced_at IS NULL) AS n_never_synced,
  COUNT(*) FILTER (WHERE stmt_mtd > 0) AS n_with_stmt_mtd
FROM base;
