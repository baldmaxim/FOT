-- 148_contractor_revoke_claim_state.sql
-- Кластер-безопасная очередь отзыва: добавляем транзиентный статус 'revoking'.
-- Воркер атомарно «клеймит» строки (UPDATE ... FOR UPDATE SKIP LOCKED →
-- sigur_sync_state='revoking') перед тяжёлой работой в Sigur, чтобы при запуске
-- нескольких инстансов (PM2 cluster -i) один и тот же отзыв не обрабатывался дважды.
-- Зависшие 'revoking' (упавший воркер) переклеймливаются по таймауту.

BEGIN;

ALTER TABLE public.contractor_passes
  DROP CONSTRAINT IF EXISTS contractor_passes_sigur_sync_state_check;

ALTER TABLE public.contractor_passes
  ADD CONSTRAINT contractor_passes_sigur_sync_state_check
  CHECK (sigur_sync_state IN ('synced', 'pending_revoke', 'revoking', 'failed'));

COMMIT;
