-- 370_employee_supervisor_ktu_access.sql
-- Вкладка «Выработка» в «Назначениях сотрудников», вторая галочка «Ставить КТУ своим бригадам»: начальник участка
-- видит «Зарплату по объектам» бригад, где он сейчас начальник участка (ручная full-привязка, роль site_supervisor),
-- и ставит рабочим КТУ 0,8–1,6, пока месяц не закрыт. Выработку и «Долю» не правит — это ОТиЗ (миграции 342, 355).
--
-- Копия 342: ключ — сотрудник, выдают только учётки payroll_section_access (гард на маршруте). Снятие — удаление
-- строки, история — в audit_logs (EMPLOYEE_SUPERVISOR_KTU_ACCESS_CHANGED). Бригады не хранятся: берутся текущие
-- связи начальника, строка без бригад ничего не открывает.
--
-- created_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285,
-- стережёт npm run audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_supervisor_ktu_access (
  employee_id bigint PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_supervisor_ktu_access IS
  'КТУ своих бригад: начальник участка видит «Зарплату по объектам» своих бригад и ставит КТУ 0,8–1,6 (вкладка «Выработка» в назначениях).';

COMMIT;
