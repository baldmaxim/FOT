-- 276: «Моя SIM» — серверные операции самостоятельного включения переадресации.
--
-- Правило переадресации МТС принимает только при подключённой услуге PE0250
-- «Переадресация вызова (периодическая)». Операция хранит запрос сотрудника
-- (тип/номер/таймер) и доводит цепочку до конца в фоне: подключить PE0250 →
-- дождаться активации → поставить правило → подтвердить чтением правил.
--
-- Гарантии (см. mts-forwarding-operations.service.ts):
--  - частичный UNIQUE: на номер одна незавершённая операция, в том числе
--    unconfirmed (исход внешней мутации неизвестен — новое нажатие не отправит дубль);
--  - send_started_at + аренда (lease_owner/lease_until): внешнюю мутацию шлёт
--    только выигравший атомарный переход; после истечения аренды — только сверка.
--
-- Номер назначения — только ciphertext (encryption.service), как остальные ПДн модуля.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS mts_forwarding_operations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES mts_business_accounts(id) ON DELETE CASCADE,
  msisdn_hash        TEXT NOT NULL,
  employee_id        INTEGER NOT NULL,
  requested_by       UUID NOT NULL,
  forwarding_type    VARCHAR(8) NOT NULL,
  target_enc         TEXT NOT NULL,
  no_reply_timer     INTEGER,
  state              VARCHAR(24) NOT NULL,
  service_event_id   TEXT,
  rule_event_id      TEXT,
  rule_attempts      INTEGER NOT NULL DEFAULT 0,
  send_started_at    TIMESTAMPTZ,
  lease_owner        TEXT,
  lease_until        TIMESTAMPTZ,
  deadline_at        TIMESTAMPTZ NOT NULL,
  next_check_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_rules    JSONB,
  last_error_code    TEXT,
  last_error_message TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  CONSTRAINT mts_forwarding_operations_state_chk CHECK (state IN (
    'service_reserved', 'service_sending', 'service_accepted', 'service_unknown',
    'rule_ready', 'rule_sending', 'rule_verifying', 'rule_confirmed',
    'unconfirmed', 'done', 'failed', 'cancelled', 'expired'
  )),
  CONSTRAINT mts_forwarding_operations_type_chk CHECK (forwarding_type IN ('CFU', 'CFNRY', 'CFNRC'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mts_forwarding_operations_active
  ON mts_forwarding_operations (account_id, msisdn_hash)
  WHERE state NOT IN ('done', 'failed', 'cancelled', 'expired');

CREATE INDEX IF NOT EXISTS idx_mts_forwarding_operations_due
  ON mts_forwarding_operations (state, next_check_at);

CREATE INDEX IF NOT EXISTS idx_mts_forwarding_operations_msisdn
  ON mts_forwarding_operations (msisdn_hash, created_at DESC);

COMMIT;
