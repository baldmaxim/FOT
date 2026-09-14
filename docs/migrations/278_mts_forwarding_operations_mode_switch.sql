-- 278: «Моя SIM» — смена режима и отключение переадресации через серверную операцию.
--
-- При активном «Переадресовывать всегда» (CFU) МТС не применяет условную
-- переадресацию. Операция теперь сначала снимает мешающие правила (по одному,
-- с подтверждением), потом ставит выбранное; отключение — та же операция kind=remove.
--
--  - kind: set | remove; для remove номер назначения не хранится;
--  - rule_action: текущая мутация этапа правила (NULL = установка, 'delete:<тип>' = снятие);
--  - send_generation: номер отправки; переходы после отправки сверяют его — запоздавшая
--    проверка прошлого шага не меняет состояние и не пишет снимок/аудит;
--  - quota_counted_at: операция засчитана в квоту изменений (общая на включение/смену/отключение);
--  - unconfirmed_from: из какого состояния операция ушла в unconfirmed;
--  - новые состояния rule_clear_sending / rule_clear_verifying (прежний код их не берёт).
--
-- Номер 277 занят (277_employee_main_object_snapshot.sql).
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE mts_forwarding_operations
  ADD COLUMN IF NOT EXISTS kind VARCHAR(8) NOT NULL DEFAULT 'set',
  ADD COLUMN IF NOT EXISTS rule_action VARCHAR(16),
  ADD COLUMN IF NOT EXISTS send_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quota_counted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unconfirmed_from VARCHAR(24);

ALTER TABLE mts_forwarding_operations ALTER COLUMN target_enc DROP NOT NULL;

ALTER TABLE mts_forwarding_operations DROP CONSTRAINT IF EXISTS mts_forwarding_operations_state_chk;
ALTER TABLE mts_forwarding_operations ADD CONSTRAINT mts_forwarding_operations_state_chk CHECK (state IN (
  'service_reserved', 'service_sending', 'service_accepted', 'service_unknown',
  'rule_ready', 'rule_sending', 'rule_verifying', 'rule_confirmed',
  'rule_clear_sending', 'rule_clear_verifying',
  'unconfirmed', 'done', 'failed', 'cancelled', 'expired'
));

ALTER TABLE mts_forwarding_operations DROP CONSTRAINT IF EXISTS mts_forwarding_operations_kind_chk;
ALTER TABLE mts_forwarding_operations ADD CONSTRAINT mts_forwarding_operations_kind_chk
  CHECK (kind IN ('set', 'remove') AND (kind = 'remove' OR target_enc IS NOT NULL));

ALTER TABLE mts_forwarding_operations DROP CONSTRAINT IF EXISTS mts_forwarding_operations_rule_action_chk;
ALTER TABLE mts_forwarding_operations ADD CONSTRAINT mts_forwarding_operations_rule_action_chk
  CHECK (rule_action IS NULL OR rule_action IN ('delete:CFU', 'delete:CFNRY', 'delete:CFNRC'));

CREATE INDEX IF NOT EXISTS idx_mts_forwarding_operations_quota
  ON mts_forwarding_operations (requested_by, quota_counted_at)
  WHERE quota_counted_at IS NOT NULL;

COMMIT;
