-- 142: режим «текущая деятельность» для отдела.
-- Помеченные отделы в единой 1С-выгрузке не дробятся по объектам:
-- одна строка на сотрудника, адрес = «Текущая деятельность».
-- Применяется вручную через psql на проде (авто-миграций нет).

ALTER TABLE public.org_departments
  ADD COLUMN IF NOT EXISTS is_current_activity boolean NOT NULL DEFAULT false;
