-- Суммарная абонплата по всем номерам МТС Бизнес (последний снимок tariff_fee).
WITH fee_snap AS (
  SELECT DISTINCT ON (msisdn_hash)
         msisdn_hash,
         (payload->>'amount')::numeric AS fee_amount
    FROM mts_business_metric_snapshot
   WHERE scope = 'msisdn'
     AND metric = 'tariff_fee'
     AND msisdn_hash IS NOT NULL
   ORDER BY msisdn_hash, captured_at DESC
),
services_snap AS (
  SELECT DISTINCT ON (msisdn_hash)
         msisdn_hash,
         payload AS product_services
    FROM mts_business_metric_snapshot
   WHERE scope = 'msisdn'
     AND metric = 'product_services'
     AND msisdn_hash IS NOT NULL
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
)
SELECT
  COUNT(*) AS numbers_total,
  COUNT(*) FILTER (WHERE COALESCE(f.fee_amount, 0) > 0) AS numbers_with_fee,
  ROUND(COALESCE(SUM(COALESCE(f.fee_amount, 0)), 0), 2) AS tariff_fee_total,
  ROUND(COALESCE(SUM(COALESCE(ss.services_monthly, 0)), 0), 2) AS services_monthly_total,
  ROUND(COALESCE(SUM(COALESCE(f.fee_amount, 0) + COALESCE(ss.services_monthly, 0)), 0), 2) AS grand_total
FROM mts_business_number_map nm
LEFT JOIN fee_snap f ON f.msisdn_hash = nm.msisdn_hash
LEFT JOIN services_sum ss ON ss.msisdn_hash = nm.msisdn_hash;
