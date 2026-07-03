-- Миграция 201: МТС «Бизнес» — история скалярных дневных метрик (баланс,
-- кредитный лимит, начисления, неоплаченные счета) по лицевым счетам и
-- номерам. Один ряд/сутки/метрику (идемпотентный upsert по уникальному
-- индексу) — основа для тренд-графиков на вкладке «Финансы». msisdn_hash —
-- как в mts_business_cdr/mts_business_number_map (не ПДн, для джойна);
-- расшифрованный номер не дублируется — берётся из mts_business_number_map.

BEGIN;

CREATE TABLE IF NOT EXISTS mts_business_metric_daily (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID REFERENCES mts_business_accounts(id) ON DELETE SET NULL,
  scope         VARCHAR(16) NOT NULL,       -- 'account' | 'msisdn'
  account_no    TEXT,                       -- заполнен при scope='account'
  msisdn_hash   TEXT,                       -- заполнен при scope='msisdn'
  metric        VARCHAR(32) NOT NULL,       -- 'balance' | 'credit_limit' | 'unpaid_amount' | 'charges_amount'
  amount        NUMERIC(18,4) NOT NULL,
  currency_code TEXT,
  valid_from    TIMESTAMPTZ,
  valid_to      TIMESTAMPTZ,
  -- Плоская колонка, а не (captured_at::date) в индексе: cast timestamptz→date
  -- зависит от TimeZone-настройки сессии, PG считает такую функцию STABLE, а
  -- не IMMUTABLE, и отказывается строить по ней индекс ("functions in index
  -- expression must be marked IMMUTABLE"). Проставляется CURRENT_DATE при upsert.
  captured_date DATE NOT NULL DEFAULT CURRENT_DATE,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Идемпотентный upsert: одна метрика на scope-цель в сутки.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mts_business_metric_daily_key
  ON mts_business_metric_daily (scope, COALESCE(account_no, ''), COALESCE(msisdn_hash, ''), metric, captured_date);

CREATE INDEX IF NOT EXISTS idx_mts_business_metric_daily_msisdn
  ON mts_business_metric_daily (msisdn_hash, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_mts_business_metric_daily_account
  ON mts_business_metric_daily (account_id, captured_at DESC);

COMMIT;
