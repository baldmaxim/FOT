-- 277: Снимок «основного объекта» сотрудников — объект с наибольшими часами за 30 дней.
--
-- Раньше «Экспорт сотрудников» и столбец «Объект» в «Управлении кадрами» считали объект
-- на лету по СКУД и корректировкам для каждого сотрудника (~25 с на всю организацию).
-- Теперь расчёт идёт раз в сутки ночью (employee-main-object-snapshot.scheduler), а
-- потребители читают готовое.
--
-- employee_main_object_snapshot — ТОЛЬКО последний успешный расчёт: строка на сотрудника,
-- у которого за период есть объект с положительными часами. Нет строки — объекта нет.
-- Весь снимок перезаписывается одной транзакцией: сбой расчёта оставляет прошлый снимок.
--
-- employee_main_object_snapshot_runs — журнал запусков (для «свежести» снимка и разбора
-- сбоев). Период снимка берётся из последнего запуска со status = 'ok'.
--
-- Номер 276 занят (276_mts_forwarding_operations.sql).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен. Данные других таблиц не меняет.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_main_object_snapshot (
  employee_id    integer PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  skud_object_id uuid NULL,
  object_name    text NOT NULL,
  hours          numeric(10, 2) NOT NULL CHECK (hours > 0),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start <= period_end)
);

COMMENT ON TABLE public.employee_main_object_snapshot IS
  'Основной объект сотрудника (макс. часы за 30 дней) — последний ночной расчёт; см. миграцию 277';

CREATE TABLE IF NOT EXISTS public.employee_main_object_snapshot_runs (
  id           bigserial PRIMARY KEY,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz NULL,
  status       text NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  employees    integer NULL,
  with_object  integer NULL,
  duration_ms  integer NULL,
  error        text NULL
);

CREATE INDEX IF NOT EXISTS employee_main_object_snapshot_runs_ok_idx
  ON public.employee_main_object_snapshot_runs (period_end DESC, id DESC)
  WHERE status = 'ok';

COMMENT ON TABLE public.employee_main_object_snapshot_runs IS
  'Журнал ночных расчётов основного объекта сотрудников; см. миграцию 277';

COMMIT;
