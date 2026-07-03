-- Миграция 203: МТС «Бизнес» — заявки на управляющие действия (добавить/
-- удалить услугу, добровольную блокировку, правило корпоративного бюджета).
-- Калька mts_business_detalization_requests: асинхронная операция → eventId
-- от МТС → статус-поллер опрашивает и обновляет. request_payload_enc может
-- содержать номер/код правила — шифруется (encryption.service, AES-256-GCM),
-- как и остальные ПДн-поля модуля.

BEGIN;

CREATE TABLE IF NOT EXISTS mts_business_action_requests (
  event_id           TEXT PRIMARY KEY,
  account_id         UUID REFERENCES mts_business_accounts(id) ON DELETE SET NULL,
  scope              VARCHAR(16) NOT NULL,       -- 'account' | 'msisdn'
  msisdn_hash        TEXT,
  account_no         TEXT,
  action_type        VARCHAR(32) NOT NULL,       -- 'service_add' | 'service_remove' | 'block_add' | 'block_remove' | 'budget_rule_add' | 'budget_rule_remove'
  request_payload_enc TEXT,                      -- зашифрованный JSON деталей запроса (externalID/productCode/limitValue…)
  status             VARCHAR(16) NOT NULL DEFAULT 'in_progress',
  requested_by       UUID,
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mts_business_action_requests_status
  ON mts_business_action_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_mts_business_action_requests_msisdn
  ON mts_business_action_requests (msisdn_hash, requested_at DESC);

COMMIT;
