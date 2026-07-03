-- Миграция 202: МТС «Бизнес» — история сложных структур (остатки пакетов,
-- тариф, подключённые услуги+стоимость, структура абонента) как JSONB-снимки.
-- Один ряд/сутки/метрику/цель (та же идемпотентная схема, что и в 201, но
-- для значений, которые не сводятся к одному числу). msisdn_hash — как в
-- mts_business_cdr/mts_business_number_map, расшифрованный номер не хранится
-- здесь (см. mts_business_number_map).

BEGIN;

CREATE TABLE IF NOT EXISTS mts_business_metric_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID REFERENCES mts_business_accounts(id) ON DELETE SET NULL,
  scope       VARCHAR(16) NOT NULL,       -- 'account' | 'msisdn'
  account_no  TEXT,
  msisdn_hash TEXT,
  metric      VARCHAR(32) NOT NULL,       -- 'validity_info' | 'bill_plan' | 'product_services' | 'hierarchy'
  payload     JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mts_business_metric_snapshot_key
  ON mts_business_metric_snapshot (scope, COALESCE(account_no, ''), COALESCE(msisdn_hash, ''), metric, (captured_at::date));

CREATE INDEX IF NOT EXISTS idx_mts_business_metric_snapshot_msisdn
  ON mts_business_metric_snapshot (msisdn_hash, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_mts_business_metric_snapshot_account
  ON mts_business_metric_snapshot (account_id, captured_at DESC);

COMMIT;
