-- 160: Backfill реального отдела для уволенных в мае 2026 (подтверждённый кадрами список, 118 чел).
-- Требует миграцию 159 (колонка employee_dismissal_events.from_department_id).
-- Источник отдела — employee_department_access (eda): последняя НЕ архивная запись
-- (is_active DESC, updated_at DESC). Заполняем from_department_id ПОСЛЕДНЕГО события увольнения
-- каждого сотрудника, только если оно ещё пустое (идемпотентно).
-- После этого уволенные отображаются в табеле своего реального отдела (ветка firedFromDept
-- в listEmployeeMembershipsForDepartmentPeriod) — за период до даты увольнения включительно.

BEGIN;

CREATE TEMP TABLE _may2026_fired (id int PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _may2026_fired (id) VALUES
(270),(536),(538),(722),(1101),(1179),(1306),(1340),(91),(750),(1446),(2484),(2034),(18),
(849),(1225),(1313),(1469),(1867),(2095),(181),(609),(665),(1807),(2296),(1861),(306),(304),
(314),(961),(962),(1108),(1123),(1809),(11),(8730),(593),(1530),(1597),(1673),(1887),(2035),
(2200),(670),(1972),(758),(2370),(1531),(1808),(1543),(365),(777),(2543),(2546),(1191),(1315),
(1317),(1798),(2176),(2211),(846),(1846),(13),(1102),(613),(2012),(488),(143),(237),(2125),
(1016),(260),(1321),(619),(57),(180),(802),(235),(29),(1983),(8722),(1274),(189),(1487),(209),
(1470),(141),(203),(1139),(1715),(1795),(1859),(1875),(1877),(2026),(990),(1314),(8729),(2268),
(1147),(2381),(2424),(1777),(1737),(312),(1806),(564),(565),(2402),(8721),(1944),(361),(94),
(512),(1992),(2023),(2190),(505);

-- Реальный отдел из eda (последняя не-архивная запись).
CREATE TEMP TABLE _eda_real ON COMMIT DROP AS
SELECT DISTINCT ON (eda.employee_id) eda.employee_id, eda.department_id
  FROM employee_department_access eda
 WHERE eda.employee_id IN (SELECT id FROM _may2026_fired)
   AND eda.department_id <> 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'
 ORDER BY eda.employee_id, eda.is_active DESC, eda.updated_at DESC;

-- Заполняем from_department_id последнего события увольнения (только пустые).
UPDATE employee_dismissal_events de
   SET from_department_id = er.department_id
  FROM _eda_real er
 WHERE de.employee_id = er.employee_id
   AND de.from_department_id IS NULL
   AND de.id = (
     SELECT d2.id FROM employee_dismissal_events d2
      WHERE d2.employee_id = de.employee_id
      ORDER BY d2.created_at DESC
      LIMIT 1
   );

-- Контроль: должно быть заполнено 118 (или меньше, если часть уже была заполнена going-forward кодом).
DO $$
DECLARE filled int;
BEGIN
  SELECT COUNT(*) INTO filled
    FROM employee_dismissal_events de
    JOIN _eda_real er ON er.employee_id = de.employee_id
   WHERE de.from_department_id = er.department_id;
  RAISE NOTICE 'backfill: событий с заполненным from_department_id = %', filled;
END $$;

COMMIT;
