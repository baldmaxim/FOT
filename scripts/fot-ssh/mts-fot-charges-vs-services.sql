-- Связь services vs charges по ВСЕМ привязанным к ФОТ номерам (для калибровки).
WITH services_snap AS (
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
charges AS (
  SELECT msisdn_hash, SUM(amount) AS charges_mtd
    FROM mts_business_metric_daily
   WHERE scope = 'msisdn' AND metric = 'charges_amount' AND msisdn_hash IS NOT NULL
     AND captured_date >= date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow'))::date
   GROUP BY msisdn_hash
),
stmt AS (
  SELECT msisdn_hash,
         COALESCE(SUM(amount) FILTER (WHERE category NOT IN ('topups')), 0) AS stmt_mtd
    FROM mts_business_statement_rows
   WHERE usage_date >= date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow'))::date
   GROUP BY msisdn_hash
)
SELECT
  COUNT(*) AS fot_linked,
  ROUND(SUM(COALESCE(ss.services_monthly,0)),2) AS sum_services,
  ROUND(SUM(COALESCE(ch.charges_mtd,0)),2) AS sum_charges_mtd,
  ROUND(SUM(COALESCE(st.stmt_mtd,0)),2) AS sum_stmt_mtd,
  COUNT(*) FILTER (WHERE COALESCE(ch.charges_mtd,0) > 0) AS n_with_charges,
  COUNT(*) FILTER (WHERE COALESCE(st.stmt_mtd,0) > 0) AS n_with_stmt
FROM mts_business_number_map nm
INNER JOIN employees e ON e.id = nm.employee_id
LEFT JOIN services_sum ss ON ss.msisdn_hash = nm.msisdn_hash
LEFT JOIN charges ch ON ch.msisdn_hash = nm.msisdn_hash
LEFT JOIN stmt st ON st.msisdn_hash = nm.msisdn_hash;
