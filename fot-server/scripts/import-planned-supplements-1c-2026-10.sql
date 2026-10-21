-- Плановые доплаты из 1С («ПлановыеДоплаты (1).xlsx», 21.10.2026) → «Справочник» → «Доплата».
--
-- Сотрудник — по СотрудникФизлицоID_FOT (= employees.id) и ФИО. «ДатаПо» 1С — день, с которого
-- доплаты уже нет, поэтому «по» = день до неё (01.10.2026 → 30.09.2026); пустая — бессрочно (миграция 322).
-- Воронцова Н.А. (ID в файле нет, в ФОТ уволена 14.10.2026) не загружается.
--
-- Пишется только тем, у кого журнал доплат пуст, и только работающим: повторный запуск — 0 строк,
-- доплату, заведённую вручную, не затирает. Автор версии — пустой (created_by NULL), аудита нет.
--
-- ЗАПУСКАТЬ ПОСЛЕ миграции 322 и деплоя бэкенда — прежний бэкенд бессрочную доплату считает снятой.
-- Запуск: psql на сервере, как миграции. Итог — список с «загружена» / «пропущена».

BEGIN;

WITH src (employee_id, full_name, amount, date_from, date_to) AS (VALUES
  (247,  'Барулин Илья Андреевич',         20000::numeric, '2023-02-01'::date, NULL::date),
  (284,  'Белякова Надежда Владимировна',  25000, '2023-09-01', NULL),
  (403,  'Власов Алексей Николаевич',      20000, '2023-02-01', NULL),
  (738,  'Казаков Евгений Игоревич',       10000, '2013-11-01', NULL),
  (753,  'Калязин Сергей Александрович',   50000, '2026-05-01', '2026-12-31'),
  (874,  'Корж Илья Семенович',            20000, '2023-03-01', NULL),
  (875,  'Коржуков Дмитрий Александрович', 60000, '2026-01-01', '2026-09-30'),
  (891,  'Кравец Данил Александрович',     60000, '2026-01-01', '2026-09-30'),
  (1392, 'Пахомова Василина Валерьевна',   30000, '2025-06-01', NULL),
  (1594, 'Сапожникова Ксения Викторовна',  25000, '2019-02-01', NULL),
  (1665, 'Смитская Юлия Александровна',    20000, '2023-01-01', NULL)
),
ins AS (
  INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to)
  SELECT s.employee_id, s.amount, s.date_from, s.date_to
    FROM src s
    JOIN employees e ON e.id = s.employee_id AND e.full_name = s.full_name
   WHERE e.employment_status = 'active'
     AND e.is_archived IS NOT TRUE
     AND NOT EXISTS (SELECT 1 FROM payroll_planned_supplements p WHERE p.employee_id = s.employee_id)
  RETURNING employee_id
)
SELECT s.employee_id, s.full_name, s.amount, s.date_from, s.date_to,
       CASE WHEN i.employee_id IS NULL THEN 'пропущена' ELSE 'загружена' END AS result
  FROM src s
  LEFT JOIN ins i USING (employee_id)
 ORDER BY s.full_name;

COMMIT;
