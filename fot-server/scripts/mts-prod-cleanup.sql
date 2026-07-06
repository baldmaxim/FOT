-- Одноразовая очистка мусорных метрик МТС Бизнес (ложный balance per-msisdn).
DELETE FROM mts_business_metric_daily
 WHERE scope = 'msisdn' AND metric = 'balance';

-- Сброс даты последнего прогона CDR-планировщика (форсировать catchup).
UPDATE sigur_runtime_state
   SET meta = meta - 'lastRunYmdMsk'
 WHERE key = 'mts_business_cdr_daily';

SELECT 'cdr' AS tbl, count(*)::bigint FROM mts_business_cdr
UNION ALL
SELECT 'charges', count(*)::bigint FROM mts_business_metric_daily WHERE metric = 'charges_amount';
