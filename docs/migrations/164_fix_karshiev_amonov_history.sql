-- 164: Восстановление истории перевода Каршиев Гуломжон Кузибоевич (2351).
-- бр.Амонова М.Н. (21.04–23.05) → бр.Шайманова Х.К.У. (с 24.05).
-- При freeze_history=true перевод перезаписал единственное открытое назначение in-place,
-- из-за чего период работы в бр.Амонова потерялся, и сотрудник не отображался в её табеле.
-- Идемпотентно (повторный прогон ничего не дублирует).

BEGIN;

-- Закрываем период в бр.Амонова М.Н.: бывшая открытая строка, ошибочно числящаяся за Шаймановым.
UPDATE employee_assignments
   SET org_department_id = '76ea6b67-fdfe-46e8-aee5-9ade962c16fe',
       effective_to      = '2026-05-23',
       change_reason     = 'Восстановление истории: перевод Амонов→Шайманов (миграция 164)',
       updated_at        = now()
 WHERE id = '6cb0f84a-1209-49ae-9093-be4377683dc2'
   AND employee_id = 2351
   AND effective_to IS NULL
   AND org_department_id = '7e8e038f-425f-4d8c-9a9e-0c6c2227b9d3';

-- Открываем период в бр.Шайманова Х.К.У. с 24.05 (только если ещё не создан).
INSERT INTO employee_assignments
  (employee_id, org_department_id, position_id, effective_from, effective_to,
   is_primary, assignment_type, change_reason)
SELECT 2351, '7e8e038f-425f-4d8c-9a9e-0c6c2227b9d3', 'ffc3cef3-0b87-48b5-a63d-8915b1533cfc',
       '2026-05-24', NULL, true, 'main',
       'Восстановление истории: перевод Амонов→Шайманов (миграция 164)'
 WHERE NOT EXISTS (
   SELECT 1 FROM employee_assignments
    WHERE employee_id = 2351
      AND org_department_id = '7e8e038f-425f-4d8c-9a9e-0c6c2227b9d3'
      AND effective_from = '2026-05-24'
 );

DO $$
DECLARE amonov int; shaiman_open int;
BEGIN
  SELECT COUNT(*) INTO amonov FROM employee_assignments
   WHERE employee_id = 2351 AND org_department_id = '76ea6b67-fdfe-46e8-aee5-9ade962c16fe';
  SELECT COUNT(*) INTO shaiman_open FROM employee_assignments
   WHERE employee_id = 2351
     AND org_department_id = '7e8e038f-425f-4d8c-9a9e-0c6c2227b9d3'
     AND effective_to IS NULL;
  RAISE NOTICE '164: периодов Амонов = % (ожид. 1), открытых Шайманов = % (ожид. 1)', amonov, shaiman_open;
END $$;

COMMIT;
