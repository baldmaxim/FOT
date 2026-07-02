-- Миграция 198: догоняющая для прода — mts_business_cdr.account_id (привязка
-- строк CDR к лицевому счёту для дашборда «По лицевым счетам»).
--
-- На проде 197 была применена ранней версией БЕЗ этой колонки; актуальная 197
-- уже содержит её для чистых установок (там она no-op благодаря IF NOT EXISTS).
-- Симптом без миграции: 500 на /api/mts-business/report/accounts-summary
-- (column c.account_id does not exist).

BEGIN;

ALTER TABLE mts_business_cdr
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES mts_business_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mts_business_cdr_account_time
  ON mts_business_cdr (account_id, started_at DESC);

COMMIT;
