-- 240_leave_request_history.sql
-- История изменений по заявлению: кто, когда и что поменял.
--
-- Зачем отдельная таблица, а не audit_logs: в модели заявления по одному слоту
-- на решение (reviewer_id/reviewed_at/review_comment) и на отмену (cancelled_*),
-- они перезаписываются — «согласовал → отменил согласование → снова правка часов»
-- схлопывается в одну строку. Аудит остаётся, но он админский и не показывается
-- ни руководителю в карточке, ни сотруднику в ЛК.
--
-- action:
--   approved      — согласовано (comment = комментарий согласующего)
--   rejected      — не согласовано (comment = комментарий)
--   cancelled     — самоотмена автором (comment = причина)
--   revoked       — согласование отменено руководителем/админом (comment = причина)
--   hours_changed — правка часов корректировки  (old/new = {"hours": N})
--   type_changed  — смена категории отделом кадров (old/new = {"request_type": "..."})
--
-- Бэкфилла нет: у заявлений до этой миграции история пустая, подпись решения
-- по-прежнему берётся из самих leave_requests.

BEGIN;

CREATE TABLE IF NOT EXISTS public.leave_request_history (
  id         BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  action     TEXT   NOT NULL CHECK (action IN (
    'approved','rejected','cancelled','revoked','hours_changed','type_changed'
  )),
  actor_id   UUID   REFERENCES public.user_profiles(id),
  old_value  JSONB,
  new_value  JSONB,
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_request_history_request
  ON public.leave_request_history (request_id, created_at DESC, id DESC);

COMMIT;
