-- 147_contractor_revoke_async_and_removals.sql
-- 1) Асинхронный отзыв пропуска: статус синхронизации с Sigur на contractor_passes.
--    enqueueRevoke сразу возвращает пропуск в пул (status='in_pool',
--    sigur_sync_state='pending_revoke'), а фоновый шедулер делает move/rename/block
--    в Sigur и выставляет 'synced' (или 'failed' после ретраев).
-- 2) Дата заявки подрядчика на удаление сотрудника — для авто-даты увольнения
--    при «Одобрить удаление» (без модалки выбора даты).

BEGIN;

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS sigur_sync_state text NOT NULL DEFAULT 'synced'
    CHECK (sigur_sync_state IN ('synced', 'pending_revoke', 'failed')),
  ADD COLUMN IF NOT EXISTS sigur_sync_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sigur_sync_error text NULL,
  ADD COLUMN IF NOT EXISTS sigur_sync_updated_at timestamptz NULL;

-- Воркер выбирает только повисшие отзывы; индекс под очередь.
CREATE INDEX IF NOT EXISTS contractor_passes_sync_pending_idx
  ON public.contractor_passes(sigur_sync_updated_at)
  WHERE sigur_sync_state = 'pending_revoke';

ALTER TABLE public.contractor_roster
  ADD COLUMN IF NOT EXISTS removal_requested_at timestamptz NULL;

COMMIT;
