-- 342_employee_brigade_output_access.sql
-- Вкладка «Выработка» в «Система → Назначения сотрудников»: кому открыт ввод выработки в
-- «Табель → Бригады» и просмотр «Зарплаты по объектам», не открывая раздел «Зарплата».
-- Пример: сотрудники ОТиЗ вносят выработку бригад и видят её распределение.
--
-- Отдельно от payroll_section_access (миграция 310) намеренно: тот список открывает весь раздел
-- и ключ — учётка, здесь только бригады и ключ — сотрудник, как у всех назначений панели.
-- Выдают только учётки из payroll_section_access (гард на маршруте). Снятие — удаление строки,
-- история — в audit_logs (EMPLOYEE_BRIGADE_OUTPUT_ACCESS_CHANGED).
--
-- created_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285,
-- стережёт npm run audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_brigade_output_access (
  employee_id bigint PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_brigade_output_access IS
  'Выработка бригад: сотрудник вносит её в «Табель → Бригады» и видит «Зарплату по объектам» (вкладка «Выработка» в назначениях).';

COMMIT;
