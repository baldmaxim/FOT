-- Migration 047: ввод отдельного флага "исключён из табеля"
--
-- Ранее кнопка "Исключить" в табеле ставила employees.is_archived = true,
-- что отправляло сотрудника в общий архив (его переставало быть видно
-- на странице /employees и во всей активной выборке). Бизнес-смысл другой:
-- "не показывать в табеле", при этом сотрудник остаётся активным.
--
-- Разводим эти сценарии: новый флаг excluded_from_timesheet используется
-- только табельными контроллерами/сервисами, is_archived остаётся за
-- реальным архивом (увольнение, ручная архивация со страницы "Сотрудники").

BEGIN;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS excluded_from_timesheet BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS excluded_from_timesheet_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS employees_excluded_from_timesheet_idx
  ON public.employees (excluded_from_timesheet)
  WHERE excluded_from_timesheet = TRUE;

COMMIT;
