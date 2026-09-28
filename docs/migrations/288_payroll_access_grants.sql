-- 288_payroll_access_grants.sql
-- Персональный доступ к разделу «Зарплата» (вкладка «Зарплата» в «Система → Назначения
-- сотрудников»). Роль у пользователя одна, поэтому бухгалтеру на роли «Офисный сотрудник»
-- раздел через матрицу ролей не выдать — право живёт на назначении, как у заместителя (283)
-- и «Руководителя экономического отдела» (241).
--
-- Грант открывает только ключ /salary/terms (экран «Условия оплаты») на весь штат:
--   view — чтение, edit — назначение условий другим (свои условия не правятся).
-- Будущие ключи раздела (/salary/payments, больничные, отпуска, удержания) он не выдаёт.
--
-- Ключ — employee_id, как у всех назначений: доступ работает и для человека без аккаунта.
-- Одна строка на сотрудника; «Нет доступа» — строки нет. История изменений — в audit_logs
-- (PAYROLL_ACCESS_CHANGED).
--
-- granted_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285,
-- стережёт npm run audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Без таблицы бэкенд считает, что грантов нет (warn в логе),
-- у администраторов всё работает как раньше. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.payroll_access_grants (
  employee_id bigint PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  access_level text NOT NULL CHECK (access_level IN ('view', 'edit')),
  granted_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payroll_access_grants IS
  'Персональный доступ к разделу «Зарплата» (/salary/terms) на весь штат: view | edit.';

COMMIT;
