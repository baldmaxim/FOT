-- 105_contractor_pass_issue_rework.sql
-- Переработка потока выпуска пропусков: ФИО подрядчик вписывает прямо в строке
-- пропуска (ростер из потока исключён), привязка пропуска к заявке напрямую,
-- объекты/точки доступа и срок действия — на самом пропуске.

BEGIN;

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS holder_name text NULL,
  ADD COLUMN IF NOT EXISTS submission_id uuid NULL
    REFERENCES public.contractor_submissions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS object_ids uuid[] NULL,
  ADD COLUMN IF NOT EXISTS access_point_names text[] NULL,
  ADD COLUMN IF NOT EXISTS expires_at date NULL;

CREATE INDEX IF NOT EXISTS contractor_passes_submission_idx
  ON public.contractor_passes(submission_id)
  WHERE submission_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
