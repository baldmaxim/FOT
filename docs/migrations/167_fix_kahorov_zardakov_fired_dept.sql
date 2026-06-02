-- 167: Исправление отображения уволенных в табеле их реального отдела.
-- Требует миграцию 159 (колонка employee_dismissal_events.from_department_id).
--
-- Кахоров Билол Тимурович (2287) — auto-fired без dismissal_date, реальный отдел
--   бр.Саъдиев З.И. (82faae5c-9e36-4b0b-b848-075586fe0a09). Увольнение 14.05.2026.
-- Зардаков Фахриддин Курбонович (633) — dismissal_date=27.05 уже есть, но в событиях
--   увольнения from_department_id=NULL (в backfill 160 не попал — был под «АЛЬЯНС ООО»
--   и удалён из финального списка). Реальный отдел — бр.Баротов З.Б.
--   (00a9ab28-2d4e-421e-a846-738a6abfdfb7). Меняем только отдел, дату оставляем.

BEGIN;

-- === Кахоров (2287): дата увольнения + исключение + событие с реальным отделом ===
UPDATE employees
   SET dismissal_date = '2026-05-14',
       excluded_from_timesheet = true,
       excluded_from_timesheet_date = '2026-05-15',
       updated_at = now()
 WHERE id = 2287
   AND employment_status = 'fired';

INSERT INTO employee_dismissal_events
  (employee_id, dismissal_date, scheduled, from_department_id, created_by)
SELECT 2287, '2026-05-14', false, '82faae5c-9e36-4b0b-b848-075586fe0a09'::uuid, NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM employee_dismissal_events de
    WHERE de.employee_id = 2287
      AND de.from_department_id = '82faae5c-9e36-4b0b-b848-075586fe0a09'::uuid
 );

-- === Зардаков (633): проставить реальный отдел в существующих событиях (where NULL) ===
UPDATE employee_dismissal_events
   SET from_department_id = '00a9ab28-2d4e-421e-a846-738a6abfdfb7'::uuid
 WHERE employee_id = 633
   AND from_department_id IS NULL;

-- excluded-флаги Зардакову (если не выставлены) — для корректного cutoff в табеле.
UPDATE employees
   SET excluded_from_timesheet = true,
       excluded_from_timesheet_date = '2026-05-28',
       updated_at = now()
 WHERE id = 633
   AND employment_status = 'fired'
   AND excluded_from_timesheet = false;

DO $$
DECLARE k int; z int;
BEGIN
  SELECT COUNT(*) INTO k FROM employee_dismissal_events
   WHERE employee_id = 2287 AND from_department_id = '82faae5c-9e36-4b0b-b848-075586fe0a09'::uuid;
  SELECT COUNT(*) INTO z FROM employee_dismissal_events
   WHERE employee_id = 633 AND from_department_id = '00a9ab28-2d4e-421e-a846-738a6abfdfb7'::uuid;
  RAISE NOTICE '167: Кахоров событий с бр.Саъдиев=% ; Зардаков событий с бр.Баротов=%', k, z;
END $$;

COMMIT;
