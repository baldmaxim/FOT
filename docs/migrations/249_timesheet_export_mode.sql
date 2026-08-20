-- Явные режимы табелирования для выгрузки «Единый файл для 1С».
--
-- До этой миграции режим был побочным эффектом назначения объекта: если отделу или
-- сотруднику назначен объект с alt_name = 'Текущая деятельность', его строки не дробились
-- по объектам. Переключателя не было, а список «ИТР-объекты» из 1С требует режима на отдел
-- с персональными исключениями.
--
-- Вводим три режима:
--   current_activity — одна строка, «Адрес объекта» = «Текущая деятельность»;
--   object           — одна строка, адрес = закреплённый объект (независимо от проходов);
--   skud             — разбивка по фактическим проходам (несколько строк на человека).
--
-- NULL = режим не задан → работает legacy-фолбэк по назначениям объектов, поэтому
-- миграция НЕ меняет поведение ни одного сотрудника до явной настройки.
--
-- Закреплённый объект хранится отдельным FK, а не выбирается «первым активным» из
-- M:N-назначений: у тех нет детерминированного порядка, результат зависел бы от плана запроса.
--
-- Каталог страниц живёт в ДВУХ местах: public.access_pages и DEFAULT_ACCESS_PAGE_CATALOG
-- в fot-server/src/config/access-control.ts — заполняем оба (второе правится в коде).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- ── 1. Режим и закреплённый объект у отделов ────────────────────────────────
ALTER TABLE org_departments
  ADD COLUMN IF NOT EXISTS timesheet_export_mode text,
  ADD COLUMN IF NOT EXISTS timesheet_export_object_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_departments_export_mode_check') THEN
    ALTER TABLE org_departments
      ADD CONSTRAINT org_departments_export_mode_check
      CHECK (timesheet_export_mode IN ('current_activity','object','skud'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_departments_export_object_fk') THEN
    ALTER TABLE org_departments
      ADD CONSTRAINT org_departments_export_object_fk
      FOREIGN KEY (timesheet_export_object_id) REFERENCES skud_objects(id);
  END IF;
  -- Двусторонний инвариант: object обязан иметь объект, остальные режимы и NULL — не должны.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_departments_export_mode_object_consistent') THEN
    ALTER TABLE org_departments
      ADD CONSTRAINT org_departments_export_mode_object_consistent
      CHECK (
        (timesheet_export_mode = 'object' AND timesheet_export_object_id IS NOT NULL)
        OR (timesheet_export_mode IS DISTINCT FROM 'object' AND timesheet_export_object_id IS NULL)
      );
  END IF;
END $$;

-- ── 2. Режим и закреплённый объект у сотрудников ────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS timesheet_export_mode text,
  ADD COLUMN IF NOT EXISTS timesheet_export_object_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_export_mode_check') THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_export_mode_check
      CHECK (timesheet_export_mode IN ('current_activity','object','skud'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_export_object_fk') THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_export_object_fk
      FOREIGN KEY (timesheet_export_object_id) REFERENCES skud_objects(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_export_mode_object_consistent') THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_export_mode_object_consistent
      CHECK (
        (timesheet_export_mode = 'object' AND timesheet_export_object_id IS NOT NULL)
        OR (timesheet_export_mode IS DISTINCT FROM 'object' AND timesheet_export_object_id IS NULL)
      );
  END IF;
END $$;

-- Выгрузка резолвит режим по списку сотрудников и по их отделам — частичные индексы
-- покрывают обе выборки (заданных режимов заведомо мало).
CREATE INDEX IF NOT EXISTS idx_employees_timesheet_export_mode
  ON employees (id) WHERE timesheet_export_mode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_departments_timesheet_export_mode
  ON org_departments (id) WHERE timesheet_export_mode IS NOT NULL;

-- ── 3. Право «режим табелирования» ──────────────────────────────────────────
-- Отдельный технический ключ, а не расширение /admin/users: назначения объектов
-- остаются админской функцией, а режим правит ещё и HR.
INSERT INTO access_pages (
  key, label, group_code, group_label, area, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system
)
VALUES
  ('/staff-control/timesheet-mode', 'Управление кадрами — режим табелирования', 'work', 'Управление',
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

-- Табельщице право не выдаём: у неё нет доступа к /staff-control, режим она там не увидит.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('admin',           '/staff-control/timesheet-mode', true,  true),
  ('hr',              '/staff-control/timesheet-mode', true,  true),
  ('manager_obj',     '/staff-control/timesheet-mode', true,  false),
  ('site_supervisor', '/staff-control/timesheet-mode', true,  false)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

COMMIT;
