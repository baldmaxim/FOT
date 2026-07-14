-- 220: свежесть выписки по номерам — очередь непрерывного конвейера
-- (mts-business-statement-rolling.service.ts).
--
-- statement_synced_at  — когда по номеру последний раз тянули выписку
--                        (Bills/BillingStatementExtdByMSISDN);
-- last_usage_at        — время последнего события в выписке (активность номера):
--                        по нему номер считается «горячим» и опрашивается чаще;
-- statement_fail_count — подряд неудачных попыток (401/1014 «номер вне доступа»,
--                        403/1010 «не в тарифе»): такие номера уходят в холодный
--                        интервал, чтобы не жечь лимит 60 запросов/мин.
--
-- Применять ДО выката бэкенда.

ALTER TABLE mts_business_number_map
  ADD COLUMN IF NOT EXISTS statement_synced_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_usage_at        timestamptz,
  ADD COLUMN IF NOT EXISTS statement_fail_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN mts_business_number_map.statement_synced_at IS
  'Последняя успешная (или окончательно неуспешная) попытка синка выписки по номеру';
COMMENT ON COLUMN mts_business_number_map.last_usage_at IS
  'Время последнего события выписки — критерий «горячего» номера для конвейера';
COMMENT ON COLUMN mts_business_number_map.statement_fail_count IS
  'Подряд неудачных синков выписки; >= 3 — номер обслуживается только по холодному интервалу';

-- Очередь конвейера: «самый несвежий первым», номера без синка (NULL) — вперёд.
CREATE INDEX IF NOT EXISTS idx_mts_number_map_statement_sync
  ON mts_business_number_map (account_id, statement_synced_at NULLS FIRST);

-- Бэкфилл активности из уже накопленных строк выписки: без него первый прогон
-- конвейера считал бы «горячими» ноль номеров и разгонялся бы сутки.
UPDATE mts_business_number_map m
   SET last_usage_at = s.max_at
  FROM (
    SELECT msisdn_hash, max(event_at) AS max_at
      FROM mts_business_statement_rows
     GROUP BY msisdn_hash
  ) s
 WHERE s.msisdn_hash = m.msisdn_hash
   AND m.last_usage_at IS DISTINCT FROM s.max_at;
