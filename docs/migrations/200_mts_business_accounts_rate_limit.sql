-- Миграция 200: лимит запросов/мин на аккаунт МТС «Бизнес» (тариф пакета
-- запросов — 60 или 300 в минуту в зависимости от подключённого пакета).
-- Переход детализации звонков на синхронный Bills/BillingStatementExtdByMSISDN
-- (по одному запросу на номер) требует явного гейта, чтобы не превышать тариф.

BEGIN;

ALTER TABLE mts_business_accounts
  ADD COLUMN IF NOT EXISTS rate_limit_per_min INTEGER NOT NULL DEFAULT 60;

COMMIT;
