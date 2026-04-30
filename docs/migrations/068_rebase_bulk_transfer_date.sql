-- 068_rebase_bulk_transfer_date.sql
-- Массовая замена даты у пакетных переводов сотрудников, попавших в БД из Excel «Назначений».
--
-- ПРОБЛЕМА: при импорте Excel «Назначений» 21.04.2026 (и 22.04.2026) у ~1270 сотрудников
-- эффективная дата перевода (employee_assignments.effective_from) выставлена в дату импорта,
-- а не в реальную дату перевода. На вкладке «Переводы и исключения» это даёт «1270 переводов
-- от одной даты». Сами пары (закрытое + открытое назначение) корректны, нужно только
-- сместить даты на корректную точку — 01.01.2026.
--
-- ЛОГИКА: для каждой пары (открытое effective_from = OLD, закрытое effective_to = OLD-1)
--   - effective_from открытого   → '2026-01-01'
--   - effective_to  закрытого    → '2025-12-31'
--
-- ЗАТРАГИВАЕТ: только пары с парным закрытым назначением. Открытые назначения без пары
-- (первичные приёмы, ~455 на 21.04 и ~250 на 20.04) не трогаются.
--
-- Перед COMMIT делаем sanity-check; если broken_pairs ≠ 0 — ROLLBACK.

BEGIN;

-- 1) Закрытые: парные к открытым с effective_from IN ('2026-04-21','2026-04-22).
UPDATE employee_assignments AS ca
SET effective_to = DATE '2025-12-31',
    updated_at = NOW()
WHERE ca.id IN (
  SELECT ca2.id
  FROM employee_assignments ca2
  JOIN employee_assignments oa
    ON oa.employee_id = ca2.employee_id
   AND oa.effective_to IS NULL
   AND oa.effective_from IN (DATE '2026-04-21', DATE '2026-04-22')
  WHERE ca2.effective_to = (oa.effective_from - INTERVAL '1 day')::date
);

-- 2) Открытые: effective_from = OLD → '2026-01-01'.
UPDATE employee_assignments
SET effective_from = DATE '2026-01-01',
    updated_at = NOW()
WHERE effective_to IS NULL
  AND effective_from IN (DATE '2026-04-21', DATE '2026-04-22')
  AND EXISTS (
    SELECT 1 FROM employee_assignments ca
    WHERE ca.employee_id = employee_assignments.employee_id
      AND ca.effective_to = DATE '2025-12-31'
  );

-- 3) Sanity-check: количество открытых на 01.01.2026 (ожидание ≈ 1270).
DO $$
DECLARE moved_count INT;
BEGIN
  SELECT COUNT(*) INTO moved_count
  FROM employee_assignments
  WHERE effective_to IS NULL AND effective_from = DATE '2026-01-01';
  RAISE NOTICE 'Открытых на 2026-01-01: %', moved_count;
END $$;

-- 4) Sanity-check инварианта: для каждой открытой 01.01.2026 парная закрытая 31.12.2025.
DO $$
DECLARE broken_count INT;
BEGIN
  SELECT COUNT(*) INTO broken_count
  FROM employee_assignments oa
  WHERE oa.effective_to IS NULL
    AND oa.effective_from = DATE '2026-01-01'
    AND NOT EXISTS (
      SELECT 1 FROM employee_assignments ca
      WHERE ca.employee_id = oa.employee_id
        AND ca.effective_to = DATE '2025-12-31'
    );
  RAISE NOTICE 'Сломанных пар (без парного закрытого 2025-12-31): %', broken_count;
  IF broken_count > 0 THEN
    RAISE EXCEPTION 'Прерываю: найдено % сломанных пар, нужен ROLLBACK', broken_count;
  END IF;
END $$;

COMMIT;
