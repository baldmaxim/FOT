-- Заморозка режимов, выведенных из персональных назначений объектов.
--
-- Резолвинг режима табелирования (миграция 249) имеет три ступени:
--   1) employees.timesheet_export_mode        — явный режим сотрудника;
--   2) org_departments.timesheet_export_mode  — явный режим отдела;
--   3) legacy-фолбэк по назначениям объектов  — сначала персональные
--      (employee_object_assignment), затем объекты отдела (department_object_assignment).
--
-- Персональная часть третьей ступени убирается из кода: employee_object_assignment —
-- это управление доступом табельщиц, и блок его редактирования скрывается из интерфейса.
-- Пока ветка жива, галочка, поставленная ради доступа, молча меняет человеку строки
-- в «Едином файле для 1С»: обычный объект → режим skud, объект «Текущая деятельность»
-- → режим current_activity, причём это перекрывает даже объекты его отдела.
--
-- Чтобы удаление ветки не изменило выгрузку, записываем тем, кто сейчас резолвится
-- через неё, ТОТ ЖЕ режим явно. После этого первая ступень отдаёт ровно то, что
-- раньше отдавала третья, и файл 1С не меняется ни на строку.
--
-- На момент подготовки на проде это 19 человек: 3 → current_activity, 16 → skud.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Обратный порядок недопустим: без миграции 15 сметчиков
-- «Экономического сектора» разом уехали бы в «Текущую деятельность», а Колганов — в СКУД.
-- Повторный запуск безопасен: условия IS NULL делают UPDATE идемпотентным.
--
-- ── ОТКАТ ───────────────────────────────────────────────────────────────────────
-- Откат по списку id безопасен ТОЛЬКО в окне деплоя, пока никто не правил режимы
-- руками: поздний `SET timesheet_export_mode = NULL` затрёт уже принятое решение
-- администратора. Поэтому шаг 2 сохраняет прежние значения в резервную таблицу
-- migration_253_backup — откатывать нужно из неё, а не по фиксированному списку.
--
--   UPDATE employees e
--      SET timesheet_export_mode = b.prev_mode, updated_at = now()
--     FROM migration_253_backup b
--    WHERE e.id = b.employee_id
--      AND e.timesheet_export_mode = b.new_mode;  -- не трогаем изменённое вручную


-- ── ШАГ 1. PREFLIGHT (выполнить ОТДЕЛЬНО и сверить глазами) ─────────────────────
-- Оператор обязан увидеть ровно 19 строк: 3 current_activity + 16 skud.
-- Если цифры разошлись — НЕ применять остальное, разбираться.
--
-- WITH ca AS (
--   SELECT id FROM skud_objects
--    WHERE lower(btrim(coalesce(alt_name, ''))) = 'текущая деятельность'
-- ),
-- personal AS (
--   SELECT eoa.employee_id,
--          bool_or(eoa.skud_object_id IN (SELECT id FROM ca)) AS is_current
--     FROM employee_object_assignment eoa
--    WHERE eoa.is_active = true
--    GROUP BY eoa.employee_id
-- )
-- SELECT e.id, e.full_name, e.employment_status, d.name AS department,
--        CASE WHEN p.is_current THEN 'current_activity' ELSE 'skud' END AS freeze_mode
--   FROM employees e
--   JOIN personal p ON p.employee_id = e.id
--   LEFT JOIN org_departments d ON d.id = e.org_department_id
--  WHERE e.timesheet_export_mode IS NULL
--    AND d.timesheet_export_mode IS NULL
--  ORDER BY freeze_mode, e.full_name;


BEGIN;

-- Тот же ключ, что берут PUT-эндпоинты режимов (TIMESHEET_MODE_LOCK_KEY в
-- timesheet-export-mode.service.ts). Без него параллельное сохранение из модалки
-- могло бы вклиниться между вычислением и записью.
SELECT pg_advisory_xact_lock(2490001);

-- ── ШАГ 2. Резерв прежних значений ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_253_backup (
  employee_id integer PRIMARY KEY,
  full_name   text,
  prev_mode   text,
  new_mode    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

WITH ca AS (
  SELECT id FROM skud_objects
   WHERE lower(btrim(coalesce(alt_name, ''))) = 'текущая деятельность'
),
personal AS (
  SELECT eoa.employee_id,
         bool_or(eoa.skud_object_id IN (SELECT id FROM ca)) AS is_current
    FROM employee_object_assignment eoa
   WHERE eoa.is_active = true
   GROUP BY eoa.employee_id
)
INSERT INTO migration_253_backup (employee_id, full_name, prev_mode, new_mode)
SELECT e.id,
       e.full_name,
       e.timesheet_export_mode,
       CASE WHEN p.is_current THEN 'current_activity' ELSE 'skud' END
  FROM employees e
  JOIN personal p ON p.employee_id = e.id
  LEFT JOIN org_departments d ON d.id = e.org_department_id
 WHERE e.timesheet_export_mode IS NULL
   AND d.timesheet_export_mode IS NULL
ON CONFLICT (employee_id) DO NOTHING;

-- ── ШАГ 3. Заморозка ────────────────────────────────────────────────────────────
-- Объект не пишем: CHECK из миграции 249 требует timesheet_export_object_id только
-- для режима 'object', а здесь только current_activity / skud.
WITH ca AS (
  SELECT id FROM skud_objects
   WHERE lower(btrim(coalesce(alt_name, ''))) = 'текущая деятельность'
),
personal AS (
  SELECT eoa.employee_id,
         bool_or(eoa.skud_object_id IN (SELECT id FROM ca)) AS is_current
    FROM employee_object_assignment eoa
   WHERE eoa.is_active = true
   GROUP BY eoa.employee_id
),
-- Выборка вынесена в CTE намеренно: в UPDATE ... FROM целевую таблицу нельзя
-- упоминать в условиях джойна FROM-списка («invalid reference to FROM-clause entry»),
-- а отдел здесь нужен именно через LEFT JOIN.
target AS (
  SELECT e.id,
         CASE WHEN p.is_current THEN 'current_activity' ELSE 'skud' END AS new_mode
    FROM employees e
    JOIN personal p ON p.employee_id = e.id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
   WHERE e.timesheet_export_mode IS NULL
     AND d.timesheet_export_mode IS NULL
)
UPDATE employees e
   SET timesheet_export_mode = t.new_mode,
       updated_at = now()
  FROM target t
 WHERE e.id = t.id;

COMMIT;


-- ── ШАГ 4. Контроль после применения ────────────────────────────────────────────
-- Ожидаем: current_activity = 3, skud = 16 (плюс ранее заданные вручную режимы).
--
-- SELECT timesheet_export_mode, count(*)
--   FROM employees WHERE timesheet_export_mode IS NOT NULL
--  GROUP BY 1 ORDER BY 2 DESC;
--
-- Персональных назначений без явного режима остаться не должно:
--
-- SELECT count(*) AS must_be_zero
--   FROM employees e
--   JOIN (SELECT DISTINCT employee_id FROM employee_object_assignment WHERE is_active) p
--     ON p.employee_id = e.id
--   LEFT JOIN org_departments d ON d.id = e.org_department_id
--  WHERE e.timesheet_export_mode IS NULL AND d.timesheet_export_mode IS NULL;
