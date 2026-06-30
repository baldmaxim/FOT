-- 193_contractor_pool_provisioning_status.sql
-- Reserve-then-provision для общего пула пропусков подрядчика.
--
-- Проблема: addPassesToPool работал «Sigur-first» — строка contractor_passes
-- писалась ТОЛЬКО после успешного создания профиля и привязки карты в Sigur.
-- При сбое Sigur номер тихо исчезал (failed[], строки нет), а getNextNumber
-- (MAX(pass_number)+1) навсегда перешагивал потерянный номер → дыры в пуле
-- (2195, 2197, 2312, 2321).
--
-- Решение: номер сначала РЕЗЕРВИРУЕТСЯ строкой status='provisioning'
-- (источник истины), затем провижинится в Sigur. Сбой провижининга → видимый
-- статус 'provisioning_failed' (с retry), а не дыра.
--
-- Эта миграция добавляет два промежуточных статуса в CHECK lifecycle и
-- partial-индекс для быстрой выборки «застрявших» строк фоновым retry.
-- Текст ошибки переиспользует существующий sigur_sync_error (миграция 148) —
-- новых колонок нет.
--
-- ВАЖНО: применять ДО деплоя бэкенда, иначе INSERT status='provisioning'
-- упадёт на старом CHECK-constraint.

BEGIN;

ALTER TABLE public.contractor_passes
  DROP CONSTRAINT IF EXISTS contractor_passes_status_check;
ALTER TABLE public.contractor_passes
  ADD CONSTRAINT contractor_passes_status_check
  CHECK (status IN (
    'in_pool',              -- в общей папке Sigur, не назначен подрядчику
    'assigned',             -- назначен подрядчику (профиль в его папке, blocked)
    'submitted',            -- ФИО вписано, в составе заявки на согласование
    'applied',              -- админ одобрил, переименован/разблокирован в Sigur
    'blocked',              -- ФИО сменено или отозвано — заблокирован до повтора
    'revoked',              -- окончательно отозван
    'provisioning',         -- номер зарезервирован, идёт выпуск в Sigur (карта/профиль)
    'provisioning_failed'   -- выпуск в Sigur не удался — ждёт повторного провижининга
  ));

-- Partial-индекс под выборку застрявших строк (retryStuckPoolPasses +
-- опциональный фоновый проход). Только строки пула (org_department_id IS NULL).
CREATE INDEX IF NOT EXISTS contractor_passes_provisioning_idx
  ON public.contractor_passes(updated_at)
  WHERE status IN ('provisioning', 'provisioning_failed')
    AND org_department_id IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
