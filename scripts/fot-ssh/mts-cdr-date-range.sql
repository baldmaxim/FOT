SELECT
  MIN(started_at)::date AS date_from,
  MAX(started_at)::date AS date_to,
  COUNT(*)::bigint AS total_calls,
  COUNT(DISTINCT msisdn_hash)::int AS numbers
FROM mts_business_cdr;
