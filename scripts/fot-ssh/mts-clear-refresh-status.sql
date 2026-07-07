-- Хирургическая очистка протухшего статуса mts_business_refresh_all
SELECT key,
       meta->'status'->>'running' AS running,
       left(meta->'status'->>'error', 80) AS error_preview
FROM sigur_runtime_state
WHERE key = 'mts_business_refresh_all';

UPDATE sigur_runtime_state
SET meta = meta - 'status'
WHERE key = 'mts_business_refresh_all';

SELECT key,
       meta ? 'status' AS has_status,
       meta
FROM sigur_runtime_state
WHERE key = 'mts_business_refresh_all';
