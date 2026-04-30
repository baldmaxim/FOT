-- 068_rebase_bulk_transfer_date.sql
-- Массовая замена даты у пакетных переводов сотрудников, попавших в БД из Excel «Назначений».
--
-- ПРОБЛЕМА: при импорте Excel «Назначений» 21.04.2026 (и 22.04.2026) у ~1270 сотрудников
-- эффективная дата перевода (employee_assignments.effective_from) выставлена в дату импорта,
-- а не в реальную дату перевода. На вкладке «Переводы и исключения» это даёт «1270 переводов
-- от одной даты». Закрытые записи у них синтетические — точечные `effective_from = effective_to`,
-- созданные тем же импортом (нет реальной истории до апреля 2026).
--
-- ЛОГИКА: переводим даты на 01.01.2026 — закрытая становится точечной 31.12.2025.
-- Учитываем триггер ensure_no_overlapping_employee_assignments — порядок и фильтры важны.
--
-- ОГРАНИЧЕНИЯ (НЕ обрабатывается миграцией):
--   - 8 двухступенчатых переводов (сотрудник переехал 21.04 и сразу 22.04) — middle-запись
--     удаляется (DELETE), но дата оставшейся пары не трогается (требует ручной разборки).
--   - 16 сотрудников с дополнительными записями `effective_from > 2025-12-31` (например,
--     закрытое 14.04→19.04) — их open оставляется на старой дате 21.04, чтобы не создавать
--     overlap с реальной историей.
--   - 1 сотрудник (employee_id=1331 на момент инцидента) с реальной историей
--     `2025-11-27 → 2026-04-19` — пропускается по тому же фильтру.
--
-- Результат на проде после применения (30.04.2026):
--   1243 пары переведены на 01.01.2026 (closed точечная 2025-12-31, open 2026-01-01)
--   8 middle-записей удалено
--   27 переводов остались на старых датах (требуют ручной обработки через UI)

BEGIN;

-- 1) Удаляем middle-запись у двухступенчатых: closed 2026-04-21→2026-04-21, парная к open 22.04.
DELETE FROM employee_assignments
WHERE id IN (
  SELECT ca.id
  FROM employee_assignments ca
  JOIN employee_assignments oa
    ON oa.employee_id = ca.employee_id
   AND oa.effective_to IS NULL
   AND oa.effective_from = DATE '2026-04-22'
  WHERE ca.effective_from = DATE '2026-04-21'
    AND ca.effective_to = DATE '2026-04-21'
);

-- 2) Closed → точечная 2025-12-31. Только если у сотрудника нет других записей,
--    перекрывающих 2025-12-31, и нет других записей с effective_from > 2025-12-31.
UPDATE employee_assignments
SET effective_from = DATE '2025-12-31',
    effective_to = DATE '2025-12-31',
    updated_at = NOW()
WHERE id IN (
  SELECT ca.id
  FROM employee_assignments ca
  JOIN employee_assignments oa
    ON oa.employee_id = ca.employee_id
   AND oa.effective_to IS NULL
   AND oa.effective_from IN (DATE '2026-04-21', DATE '2026-04-22')
  WHERE ca.effective_to = (oa.effective_from - INTERVAL '1 day')::date
    AND NOT EXISTS (
      SELECT 1 FROM employee_assignments other
      WHERE other.employee_id = ca.employee_id
        AND other.id <> ca.id
        AND other.effective_from <= DATE '2025-12-31'
        AND COALESCE(other.effective_to, DATE '9999-12-31') >= DATE '2025-12-31'
    )
    AND NOT EXISTS (
      SELECT 1 FROM employee_assignments other
      WHERE other.employee_id = ca.employee_id
        AND other.id <> ca.id
        AND other.id <> oa.id
        AND other.effective_from > DATE '2025-12-31'
        AND other.effective_to IS NOT NULL
    )
);

-- 3) Open → 2026-01-01. Только для сотрудников, у которых closed уже точечная 2025-12-31.
UPDATE employee_assignments
SET effective_from = DATE '2026-01-01',
    updated_at = NOW()
WHERE effective_to IS NULL
  AND effective_from IN (DATE '2026-04-21', DATE '2026-04-22')
  AND EXISTS (
    SELECT 1 FROM employee_assignments ca
    WHERE ca.employee_id = employee_assignments.employee_id
      AND ca.effective_from = DATE '2025-12-31'
      AND ca.effective_to = DATE '2025-12-31'
  );

-- 4) Sanity-check.
DO $$
DECLARE moved_count INT;
DECLARE broken_count INT;
BEGIN
  SELECT COUNT(*) INTO moved_count
  FROM employee_assignments
  WHERE effective_to IS NULL AND effective_from = DATE '2026-01-01';
  RAISE NOTICE 'Открытых на 2026-01-01: %', moved_count;

  SELECT COUNT(*) INTO broken_count
  FROM employee_assignments oa
  WHERE oa.effective_to IS NULL
    AND oa.effective_from = DATE '2026-01-01'
    AND NOT EXISTS (
      SELECT 1 FROM employee_assignments ca
      WHERE ca.employee_id = oa.employee_id
        AND ca.effective_from = DATE '2025-12-31'
        AND ca.effective_to = DATE '2025-12-31'
    );
  RAISE NOTICE 'Сломанных пар (без парного closed 31.12.2025): %', broken_count;
  IF broken_count > 0 THEN
    RAISE EXCEPTION 'Прерываю: найдено % сломанных пар', broken_count;
  END IF;
END $$;

COMMIT;
