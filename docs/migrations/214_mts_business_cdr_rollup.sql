-- Миграция 214: МТС «Бизнес» — роллап детализации звонков (mts_business_cdr)
-- как materialized view. Список абонентов (listSubscribers) агрегировал всю
-- таблицу mts_business_cdr (267k строк / 208 МБ) при каждой загрузке — полный
-- Parallel Seq Scan, ~430 мс тёплый и секунды на холодном кэше. Роллап сводит
-- CDR к одной строке на номер (~700), обновляется раз в сутки после ночного
-- синка CDR и при «Обновить всё» (REFRESH MATERIALIZED VIEW CONCURRENTLY).
-- UNIQUE-индекс по msisdn_hash обязателен для CONCURRENTLY-обновления.

BEGIN;

CREATE MATERIALIZED VIEW IF NOT EXISTS mts_business_cdr_rollup AS
  SELECT msisdn_hash,
         MIN(msisdn_enc)               AS msisdn_enc,
         COUNT(*)                      AS calls,
         COALESCE(SUM(duration_sec), 0) AS total_sec,
         MAX(started_at)               AS last_call_at,
         MAX(account_id::text)         AS account_id
    FROM mts_business_cdr
   WHERE msisdn_hash IS NOT NULL
   GROUP BY msisdn_hash;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mts_business_cdr_rollup_msisdn
  ON mts_business_cdr_rollup (msisdn_hash);

COMMIT;
