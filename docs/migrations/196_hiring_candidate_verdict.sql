-- 196_hiring_candidate_verdict.sql
-- Вердикт заказчика/HR по кандидату («Пригласить»/«Отказать») в воронке подбора.
-- Это МНЕНИЕ по кандидату, а не статус воронки (status двигает рекрутёр отдельно).
-- Комментарий к вердикту пишется в существующие seeker_feedback (HR/рекрутёр) или
-- applicant_feedback (заказчик) — новых полей под текст не заводим.

BEGIN;

ALTER TABLE public.hiring_candidates
  ADD COLUMN IF NOT EXISTS applicant_verdict text NULL
    CHECK (applicant_verdict IN ('invite', 'reject')),
  ADD COLUMN IF NOT EXISTS verdict_by uuid NULL REFERENCES public.user_profiles(id),
  ADD COLUMN IF NOT EXISTS verdict_at timestamptz NULL;

COMMIT;
