-- 291: «Режим табелирования» в «Управлении кадрами» — «Офис» отделу или сотруднику.
--
-- Отдел с «Офисом» — строка в timesheet_office_departments: всем его прямым своим работающим
-- сотрудникам объект табелирования «Офис» (current_activity). Ставит окно сразу, ночной
-- расчёт держит (переведённым позже — ближайшей ночью). Подотделы правило не получают.
-- Личный «Офис» новых колонок не требует: employees.timesheet_export_mode = 'current_activity'
-- с set_by = NULL и автором (289). Кому «Офис» поставлен в окне — лично или через отдел, —
-- тому выбор объекта в ЛК и табеле закрыт.
--
-- created_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285,
-- стережёт npm run audit:user-fk).
--
-- Право /staff-control/timesheet-office — новое: ключ /staff-control/timesheet-mode не берём,
-- повторный прогон 290 удалил бы его.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый ночной расчёт и выбор объекта читают таблицу, старому
-- бэкенду она не мешает. Повторный запуск безопасен и данные не меняет.

BEGIN;

CREATE TABLE IF NOT EXISTS public.timesheet_office_departments (
  org_department_id uuid PRIMARY KEY REFERENCES public.org_departments(id) ON DELETE CASCADE,
  created_by        uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.timesheet_office_departments IS
  'Отделы с «Офисом» из окна «Режим табелирования»: прямым сотрудникам объект табелирования «Офис», выбор закрыт; см. миграцию 291';

-- Проверка схемы: CREATE TABLE IF NOT EXISTS не сверяет уже существующую таблицу.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'timesheet_office_departments'
     AND (
       (column_name = 'org_department_id' AND data_type = 'uuid' AND is_nullable = 'NO')
       OR (column_name = 'created_by' AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL)
       OR (column_name = 'created_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO')
     );
  IF v_count <> 3 THEN
    RAISE EXCEPTION '291: колонки timesheet_office_departments не совпадают со схемой (%/3)', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.timesheet_office_departments'::regclass
     AND c.contype = 'p'
     AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
         = ARRAY['org_department_id'];
  IF v_count <> 1 THEN
    RAISE EXCEPTION '291: PK timesheet_office_departments должен быть (org_department_id)';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.timesheet_office_departments'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.org_departments'::regclass
     AND c.confdeltype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '291: нет FK timesheet_office_departments.org_department_id → org_departments ON DELETE CASCADE';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint c
   WHERE c.conrelid = 'public.timesheet_office_departments'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'public.user_profiles'::regclass
     AND c.confdeltype = 'n';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '291: нет FK timesheet_office_departments.created_by → user_profiles ON DELETE SET NULL';
  END IF;
END $$;

-- Право «Управление кадрами — режим табелирования» (образец — 249).
INSERT INTO access_pages (
  key, label, group_code, group_label, area, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system
)
VALUES
  ('/staff-control/timesheet-office', 'Управление кадрами — режим табелирования', 'work', 'Управление',
   'admin', 'technical', true, false, false, 164, true, true)
ON CONFLICT (key) DO UPDATE SET
  label         = EXCLUDED.label,
  group_code    = EXCLUDED.group_code,
  group_label   = EXCLUDED.group_label,
  area          = EXCLUDED.area,
  surface       = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order    = EXCLUDED.sort_order,
  is_active     = EXCLUDED.is_active;

-- Только администратор и кадровый админ.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('admin',    '/staff-control/timesheet-office', true, true),
  ('hr_admin', '/staff-control/timesheet-office', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

COMMIT;
