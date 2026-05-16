-- 102_contractor_pass_object.sql
-- ЭТАП 2: объект (набор точек доступа) на пропуск. Админ выбирает объект при
-- выпуске пачки; при согласовании точки доступа объекта биндятся в Sigur
-- к переименованному профилю.

BEGIN;

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS skud_object_id uuid NULL
    REFERENCES public.skud_objects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS contractor_passes_skud_object_idx
  ON public.contractor_passes(skud_object_id)
  WHERE skud_object_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
