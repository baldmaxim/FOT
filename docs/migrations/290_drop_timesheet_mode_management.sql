-- 290: удаление ручной настройки «Режим табелирования» (миграция 249).
--
-- С 29.09.2026 объект табелирования назначается автоматически (миграция 288: ночной расчёт,
-- выбор в ЛК и табеле). Окно «Режим табелирования» в «Управлении кадрами», его API
-- /api/admin/timesheet-modes, скрипты массовой установки и режим отдела удалены из кода.
--
-- Удаляется:
--   - право /staff-control/timesheet-mode (каталог + гранты ролей, повтор паттерна 104);
--   - режим отдела: org_departments.timesheet_export_mode / timesheet_export_object_id
--     (CHECK, FK и индекс уходят вместе с колонками; представлений и триггеров на них нет).
--
-- НЕ трогается: личный объект сотрудника (employees.timesheet_export_*), фиксации месяцев,
-- закрытые редакции табелей, аудит, назначения объектов отделам (правило «офис отдела»).
--
-- Гард: удаление режима отдела не должно менять выгрузку в 1С. Без режима отдела сотрудник
-- без личного объекта получает значение по умолчанию: current_activity, если у отдела
-- активное назначение офиса («Текущая деятельность»), иначе skud. Если у какого-то отдела
-- режим отличается от этого значения (в том числе object), миграция останавливается и
-- ничего не меняет. Удаляемые значения печатаются NOTICE — вывод psql сохранить: по нему
-- колонки можно вернуть.
--
-- ПРИМЕНЯТЬ ПОСЛЕ ДЕПЛОЯ БЭКЕНДА: старый бэкенд читает колонки режима отдела.
-- Forward-only: вернуть старый бэкенд без восстановления колонок нельзя.
-- Повторный запуск безопасен: без колонок гард пропускается, удаления идемпотентны.

BEGIN;

-- ALTER TABLE берёт эксклюзивную блокировку org_departments: не ждать долго, а упасть.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  r   record;
  bad integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'org_departments'
       AND column_name = 'timesheet_export_mode'
  ) THEN
    RAISE NOTICE '290: колонок режима отдела уже нет — проверка пропущена';
    RETURN;
  END IF;

  FOR r IN EXECUTE $q$
    WITH ca AS (
      SELECT id FROM skud_objects
       WHERE lower(btrim(coalesce(alt_name, ''))) = lower('Текущая деятельность')
    ),
    dept_ca AS (
      SELECT DISTINCT doa.org_department_id
        FROM department_object_assignment doa
       WHERE doa.is_active = true AND doa.skud_object_id IN (SELECT id FROM ca)
    )
    SELECT d.id,
           d.name,
           d.timesheet_export_mode             AS mode,
           d.timesheet_export_object_id::text  AS object_id,
           CASE WHEN dc.org_department_id IS NOT NULL THEN 'current_activity' ELSE 'skud' END AS fallback
      FROM org_departments d
      LEFT JOIN dept_ca dc ON dc.org_department_id = d.id
     WHERE d.timesheet_export_mode IS NOT NULL
     ORDER BY d.name
  $q$
  LOOP
    RAISE NOTICE '290: отдел «%» (%): режим %, объект %, по умолчанию %',
      r.name, r.id, r.mode, coalesce(r.object_id, '—'), r.fallback;
    IF r.mode IS DISTINCT FROM r.fallback THEN
      bad := bad + 1;
    END IF;
  END LOOP;

  IF bad > 0 THEN
    RAISE EXCEPTION '290 остановлена: у % отдел(ов) режим отличается от правила по умолчанию — удаление изменило бы выгрузку в 1С', bad;
  END IF;
END $$;

DELETE FROM role_page_access WHERE page_path = '/staff-control/timesheet-mode';
DELETE FROM access_pages     WHERE key       = '/staff-control/timesheet-mode';

ALTER TABLE org_departments
  DROP COLUMN IF EXISTS timesheet_export_mode,
  DROP COLUMN IF EXISTS timesheet_export_object_id;

COMMIT;
