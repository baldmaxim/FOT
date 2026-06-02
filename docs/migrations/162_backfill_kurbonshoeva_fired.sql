-- 162: Добавление в табель уволенных, не попавших в backfill 160 (отсутствовала dismissal_date).
-- Имомназаров Имомназар Абдолбекович (697) и Аноятшоев Хушвахтшо Айналишоевич (152) —
-- auto-fired через Sigur без dismissal_date, реальный отдел бр.Курбоншоева Х.Ш.
-- Дата увольнения 14.05.2026 (последний день в табеле; СКУД-присутствие было до 06–07.05).
-- Требует миграцию 159 (колонка from_department_id).

BEGIN;

-- Дата увольнения + исключение из табеля с 15.05 (день после dismissal_date).
UPDATE employees
   SET dismissal_date = '2026-05-14',
       excluded_from_timesheet = true,
       excluded_from_timesheet_date = '2026-05-15',
       updated_at = now()
 WHERE id IN (152, 697)
   AND employment_status = 'fired';

-- Событие увольнения с реальным отделом (идемпотентно — только если ещё нет такого события).
INSERT INTO employee_dismissal_events
  (employee_id, dismissal_date, scheduled, from_department_id, created_by)
SELECT v.id, '2026-05-14', false, '5e6983f3-ea5a-4fcb-b576-8c49b864892b'::uuid, NULL
  FROM (VALUES (152), (697)) AS v(id)
 WHERE NOT EXISTS (
   SELECT 1 FROM employee_dismissal_events de
    WHERE de.employee_id = v.id
      AND de.from_department_id = '5e6983f3-ea5a-4fcb-b576-8c49b864892b'::uuid
 );

DO $$
DECLARE cnt int;
BEGIN
  SELECT COUNT(*) INTO cnt
    FROM employee_dismissal_events
   WHERE employee_id IN (152, 697)
     AND from_department_id = '5e6983f3-ea5a-4fcb-b576-8c49b864892b'::uuid;
  RAISE NOTICE '162: событий с отделом бр.Курбоншоева Х.Ш. = % (ожидается 2)', cnt;
END $$;

COMMIT;
