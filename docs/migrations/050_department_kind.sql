-- Migration 050: вводим признак «вид отдела» (kind)
--
-- Контекст: ранее в коде классификация «бригада / отдел / объект»
-- держалась на конвенции имени (startsWith 'бр.'). Это хрупко:
-- переименование ломает логику. Добавляем явный столбец kind с
-- allow-list значений.
--
-- Значения:
--   'department' — обычный административный отдел (по умолчанию).
--   'brigade'    — бригада («бр. …»). Группа бригад одного начальника
--                  образует «участок» на уровне UI (не в БД).
--   'object'     — строительный объект. Корневой виртуальный отдел
--                  Sigur «Объект». Значение зарезервировано для будущей
--                  выгрузки табелей «по объекту».
--
-- Миграция идемпотентна.

BEGIN;

ALTER TABLE public.org_departments
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'department';

ALTER TABLE public.org_departments
  DROP CONSTRAINT IF EXISTS org_departments_kind_check;

ALTER TABLE public.org_departments
  ADD CONSTRAINT org_departments_kind_check
  CHECK (kind IN ('department', 'brigade', 'object'));

-- Бэкфилл: всё, что имя начинается с «бр.» (любой регистр, с возможными пробелами).
UPDATE public.org_departments
SET kind = 'brigade'
WHERE kind = 'department'
  AND lower(btrim(name)) LIKE 'бр.%';

-- Виртуальный корень Sigur («Объект») помечаем как объект.
UPDATE public.org_departments
SET kind = 'object'
WHERE kind = 'department'
  AND parent_id IS NULL
  AND btrim(name) = 'Объект';

CREATE INDEX IF NOT EXISTS idx_org_departments_kind
  ON public.org_departments(kind)
  WHERE is_active = true;

COMMIT;

-- Санитарный запрос (для проверки после миграции):
-- SELECT kind, count(*) FROM public.org_departments WHERE is_active = true GROUP BY kind;
