-- Правка закрытого табеля админом должна доходить до 1С.
--
-- Миграция 256 ввела официальные версии закрытых табелей: версия создаётся при approve
-- и при каждом закрытии утверждённого периода, 1С видит изменения по revision.
--
-- Пробел: у админа есть право писать в закрытый период в обход замка (существующее
-- поведение, `if (req.user.is_admin) return null` в timesheet.controller.ts и
-- correction-approval.controller.ts). Такая правка меняла часы в ФОТ, но версия
-- оставалась прежней — 1С молча продолжала отдавать старые часы, и никакого сигнала
-- об этом не было.
--
-- Решение: любая запись админа в закрытый период помечает подачу «версия устарела»,
-- фоновый воркер пересобирает снимок и создаёт новую редакцию. Для 1С результат
-- становится таким же, как после «Открыть → поправить → Закрыть», разница только во
-- времени появления редакции (сразу против ~30–90 секунд).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- ── 1. Метка «версия устарела» и очередь пересборки ─────────────────────────
ALTER TABLE timesheet_approvals
  ADD COLUMN IF NOT EXISTS version_dirty_at           TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS version_dirty_seq          BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS version_rebuild_attempts   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS version_rebuild_after      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS version_rebuild_last_error TEXT NULL;

COMMENT ON COLUMN timesheet_approvals.version_dirty_at IS
  'Момент правки, попавшей в закрытый период (правка админа в обход замка). NULL = '
  'сохранённая версия актуальна. Пока метка стоит, табель не выдаётся в 1С: иначе она '
  'успела бы забрать старые часы и подтвердить их.';

-- Счётчик, а не только timestamp: две правки могут получить одинаковое время, и правка,
-- пришедшая во время сборки, потерялась бы. Воркер снимает метку только при совпадении
-- seq — это compare-and-swap.
COMMENT ON COLUMN timesheet_approvals.version_dirty_seq IS
  'Номер правки для compare-and-swap: воркер очищает version_dirty_at, только если seq '
  'не изменился с момента выборки задания.';

-- Backoff: без него 20 постоянно падающих подач выбирались бы каждую минуту и заняли
-- бы весь лимит батча, заблокировав очередь остальным.
COMMENT ON COLUMN timesheet_approvals.version_rebuild_after IS
  'Не пытаться пересобирать раньше этого момента (растущая задержка после ошибок).';
COMMENT ON COLUMN timesheet_approvals.version_rebuild_last_error IS
  'Текст последней ошибки пересборки — для разбора зависших меток.';

CREATE INDEX IF NOT EXISTS idx_timesheet_approvals_version_dirty
  ON timesheet_approvals (version_dirty_at)
  WHERE version_dirty_at IS NOT NULL;

-- ── 2. Новый источник версии ────────────────────────────────────────────────
-- Версия, собранная фоновым воркером после админской правки, отличается от approve/close.
ALTER TABLE timesheet_versions
  DROP CONSTRAINT IF EXISTS timesheet_versions_source_check;
ALTER TABLE timesheet_versions
  ADD CONSTRAINT timesheet_versions_source_check
  CHECK (source IN ('approve', 'close', 'backfill', 'rebuild'));

COMMIT;
