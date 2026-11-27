-- 382_employee_team_salary_access.sql
-- Вкладка «Выработка» в «Назначениях сотрудников», третья галочка «Видеть зарплату своих сотрудников в табеле»:
-- руководитель отдела (ручная full-привязка, не sigur_sync) видит в табеле столбец «Зарплата» — к выплате за прошлый
-- месяц своих людей с подотделами, с расшифровкой «Расчёт ФОТ». Начальник участка — то же по своим бригадам (его
-- бригады — такие же full-привязки). Заместители (deputy) и «Мои сотрудники» в охват не входят.
--
-- Копия 342/370: ключ — сотрудник, выдают только учётки payroll_section_access (гард на маршруте). Снятие — удаление
-- строки, история — в audit_logs (EMPLOYEE_TEAM_SALARY_ACCESS_CHANGED). Отделы не хранятся: берутся текущие
-- full-привязки руководителя, строка без них ничего не открывает.
--
-- Таблица создаётся пустой: после деплоя доступа нет ни у кого (решение пользователя 27.11.2026). Включить —
-- галочкой в «Назначениях» или:
--   INSERT INTO employee_team_salary_access (employee_id) VALUES (<id сотрудника>) ON CONFLICT DO NOTHING;
-- Снять: DELETE FROM employee_team_salary_access WHERE employee_id = <id сотрудника>;
--
-- created_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285,
-- стережёт npm run audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_team_salary_access (
  employee_id bigint PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_team_salary_access IS
  'Зарплата своих сотрудников в табеле: руководитель видит столбец «Зарплата» (прошлый месяц) по своим отделам с подотделами (вкладка «Выработка» в назначениях).';

COMMIT;
