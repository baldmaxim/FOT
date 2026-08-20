-- «Открыть / Закрыть табель»: временное снятие замка с закрытого периода.
--
-- Замок закрытого табеля (timesheet-lock.service.ts) опирается на
-- timesheet_approvals.status IN ('submitted','approved'). Чтобы кадровая служба или
-- админ могли на время разрешить правки табельщицам и руководителям, не трогая статус
-- подачи, добавляем отдельный признак: unlocked_at IS NOT NULL = период открыт.

BEGIN;

ALTER TABLE timesheet_approvals
  ADD COLUMN IF NOT EXISTS unlocked_at   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS unlocked_by   UUID NULL REFERENCES user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unlock_reason TEXT NULL;

-- Открытым может быть только закрытый период. Страховка на случай, если какой-то путь
-- смены статуса забудет обнулить флаг: «зависшее» открытие не должно пережить
-- recall/переподачу/возврат и снять замок в draft/returned.
ALTER TABLE timesheet_approvals
  DROP CONSTRAINT IF EXISTS timesheet_approvals_unlock_status_check;
ALTER TABLE timesheet_approvals
  ADD CONSTRAINT timesheet_approvals_unlock_status_check
  CHECK (unlocked_at IS NULL OR status IN ('submitted', 'approved'));

COMMENT ON COLUMN timesheet_approvals.unlocked_at IS
  'Период временно открыт для правок (NULL = закрыт). Статус подачи при этом не меняется.';
COMMENT ON COLUMN timesheet_approvals.unlocked_by IS
  'Кто открыл период (админ или кадровая служба).';
COMMENT ON COLUMN timesheet_approvals.unlock_reason IS
  'Необязательная причина открытия, до 500 символов.';

COMMIT;
