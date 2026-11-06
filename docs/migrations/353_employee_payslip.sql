-- 353_employee_payslip.sql
-- Расчётный лист и остаток отпуска в личном кабинете сотрудника (страница /employee/payslip).
--
-- Кто видит: сотрудники из списка employee_payslip_access ИЛИ все учётки с привязанным сотрудником, если
-- system_settings.employee_payslip_for_all = 'true'. Роль доступа не даёт и не отнимает — администраторам тоже
-- (ветка в resolveEffectivePageAccess стоит до обхода is_admin). Учётка без сотрудника листка не видит никогда.
--   Добавить:     INSERT INTO employee_payslip_access (employee_id) VALUES (<id>) ON CONFLICT DO NOTHING;
--   Убрать:       DELETE FROM employee_payslip_access WHERE employee_id = <id>;
--   Включить всем: UPDATE system_settings SET value = 'true', updated_at = NOW() WHERE key = 'employee_payslip_for_all';
-- Действует со следующего запроса к API; пункт меню — после обновления профиля (перезахода).
--
-- Какие месяцы видны: только отмеченные в employee_payslip_months. «Оплачено» 1С грузится порциями (сентябрь 2026 на
-- 06.11 — у 662 человек из ~1600, дельта не запущена), поэтому месяц попадает в ЛК только после явной отметки — после
-- загрузки и сверки. source — откуда суммы месяца: '1c' — «Оплачено» 1С, 'fot' — расчёт ФОТ по закрытому табелю
-- (когда 1С грузить перестанут). Источник на экране не показывается и сам не переключается.
--   Отметить месяц: INSERT INTO employee_payslip_months (month, source) VALUES ('2026-09-01', '1c')
--                     ON CONFLICT (month) DO UPDATE SET source = EXCLUDED.source;
--   Снять отметку:  DELETE FROM employee_payslip_months WHERE month = '2026-09-01';
--
-- employee_id — владение (строка принадлежит сотруднику): ON DELETE CASCADE. Ссылок на user_profiles нет.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый бэкенд без таблиц никого на страницу не пустит (ошибка БД = «нет доступа»).
-- Прежний бэкенд с миграцией работает. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_payslip_access (
  employee_id integer PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_payslip_access IS
  'Кому виден расчётный лист в личном кабинете (пока не включён всем — system_settings.employee_payslip_for_all).';

CREATE TABLE IF NOT EXISTS public.employee_payslip_months (
  month date PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
  source text NOT NULL CHECK (source IN ('1c', 'fot')),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_payslip_months IS
  'Месяцы расчётного листа в ЛК: отмечаются после загрузки и сверки; source — суммы из «Оплачено» 1С или расчёта ФОТ.';

INSERT INTO public.system_settings (key, value, description)
VALUES (
  'employee_payslip_for_all',
  'false',
  'Расчётный лист в ЛК: true — всем учёткам с привязанным сотрудником, иначе — только списку employee_payslip_access'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO access_pages (
  key, label, group_code, group_label, area, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system
)
VALUES
  ('/employee/payslip', 'Расчётный лист', 'lk', 'Личный кабинет',
   'personal', 'page', false, false, false, 21, true, true)
ON CONFLICT (key) DO UPDATE SET
  label         = EXCLUDED.label,
  group_code    = EXCLUDED.group_code,
  group_label   = EXCLUDED.group_label,
  area          = EXCLUDED.area,
  surface       = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order    = EXCLUDED.sort_order,
  is_active     = EXCLUDED.is_active;

-- Стартовый список. Отсутствующие id (локальная/тестовая БД) пропускаются.
INSERT INTO public.employee_payslip_access (employee_id)
SELECT id
  FROM public.employees
 WHERE id IN (
   2520,  -- Есенов Максим Николаевич
   2394   -- Пашаева Луарат Рамазановна
 )
ON CONFLICT (employee_id) DO NOTHING;

-- Загружены и сверены: май, июнь — бригады; июль, август — все. Сентябрь — после дельты, отдельной командой.
INSERT INTO public.employee_payslip_months (month, source)
VALUES
  ('2026-05-01', '1c'),
  ('2026-06-01', '1c'),
  ('2026-07-01', '1c'),
  ('2026-08-01', '1c')
ON CONFLICT (month) DO NOTHING;

COMMIT;
