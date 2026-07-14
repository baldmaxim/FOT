-- 215_fix_osa_tender_return_assignments.sql
-- Починка истории назначений пятерых сотрудников Тендерного отдела,
-- побывавших в «Отделе Системного Анализа» (ОСА) с конца апреля 2026.
--
-- Что произошло: 08.07.2026 всех пятерых вернули из ОСА в Тендерный через FOT
-- «Перевод в другой отдел» задним числом (датой 01.04). Бэкдейт-перевод вставил
-- только закрытый период до ухода в ОСА и НЕ закрыл само назначение ОСА, а
-- syncLinkedEmployeeFromSigur перезаписал снапшот employees.org_department_id
-- напрямую — фоновый синк перестал видеть расхождение и возврат в историю так
-- и не был дописан. Итог: у четверых (Узун 1833, Гривапш 475, Оларь 2510,
-- Репников 2511) назначение ОСА до сих пор ОТКРЫТО (двойное членство), а у
-- Кульдяева (938) возврат случайно дописан фоновым синком датой 08.07 — из-за
-- чего табель Тендерного за июль режет ему дни 1–7.
--
-- Решение (согласовано): апрель–июнь НЕ переписываем (по ним есть утверждённые
-- табели ОСА за май и 1–15 июня), возврат в Тендерный датируем 01.07.2026 —
-- июль целиком в Тендерном.
--
-- Порядок выкладки: СНАЧАЛА задеплоить бэкенд с фиксом бэкдейт-ветки
-- changeDepartment (или остановить фоновые синки на окно работ), ПОТОМ эта
-- миграция, затем контрольный SELECT в хвосте.
--
-- Отделы:
--   ОСА       aed8610f-a93c-4776-bb6a-de645cc2422f
--   Тендерный cfb01a32-86e8-47e3-bfff-7aec07bf6eae
--
-- Вся правка в одном DO-блоке: любое расхождение с ожидаемым исходным
-- состоянием или неожиданное число изменённых строк → RAISE EXCEPTION →
-- ROLLBACK всей транзакции ДО фиксации.

BEGIN;

DO $$
DECLARE
  c_osa    CONSTANT uuid := 'aed8610f-a93c-4776-bb6a-de645cc2422f';
  c_tender CONSTANT uuid := 'cfb01a32-86e8-47e3-bfff-7aec07bf6eae';
  -- Кульдяев 938
  c_kuld_osa    CONSTANT uuid := '6ba7e0fa-ce1e-4e11-8920-55067455109e'; -- ОСА 28.04–07.07
  c_kuld_tender CONSTANT uuid := '151f64d4-9423-436b-be1f-e2ca3628a1c8'; -- Тендерный с 08.07, открыт
  v_cnt integer;
BEGIN
  ---------------------------------------------------------------------------
  -- ПРЕДУСЛОВИЯ
  ---------------------------------------------------------------------------

  -- Все пятеро существуют, снапшот у каждого — Тендерный.
  SELECT count(*) INTO v_cnt
    FROM public.employees
   WHERE id IN (938, 1833, 475, 2510, 2511)
     AND org_department_id = c_tender;
  IF v_cnt <> 5 THEN
    RAISE EXCEPTION 'Предусловие: ожидалось 5 сотрудников со снапшотом «Тендерный», найдено %', v_cnt;
  END IF;

  -- У четверых зависшее ОТКРЫТОЕ назначение ОСА — ровно эти 4 строки.
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments
   WHERE id IN ('6940e5f4-c722-4084-a970-2b9b95fcfbaa',  -- Узун 1833,    ОСА с 22.04
                '353b4c01-3de0-4adf-9c82-47d83d1d3aa8',  -- Гривапш 475,  ОСА с 22.04
                'cc7fa04f-0ae4-46ec-8c6f-8552c8adb4e9',  -- Оларь 2510,   ОСА с 07.05
                '60271aaf-c3cf-4b4d-a10f-a151690be42f')  -- Репников 2511, ОСА с 07.05
     AND employee_id IN (1833, 475, 2510, 2511)
     AND org_department_id = c_osa
     AND effective_to IS NULL;
  IF v_cnt <> 4 THEN
    RAISE EXCEPTION 'Предусловие: ожидалось 4 открытых назначения ОСА у 1833/475/2510/2511, найдено %', v_cnt;
  END IF;

  -- И других открытых назначений у этих четверых нет.
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments
   WHERE employee_id IN (1833, 475, 2510, 2511)
     AND effective_to IS NULL
     AND id NOT IN ('6940e5f4-c722-4084-a970-2b9b95fcfbaa',
                    '353b4c01-3de0-4adf-9c82-47d83d1d3aa8',
                    'cc7fa04f-0ae4-46ec-8c6f-8552c8adb4e9',
                    '60271aaf-c3cf-4b4d-a10f-a151690be42f');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Предусловие: у 1833/475/2510/2511 есть % лишних открытых назначений', v_cnt;
  END IF;

  -- Кульдяев: ОСА закрыт 07.07, Тендерный открыт с 08.07 — то, что двигаем.
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments
   WHERE id = c_kuld_osa
     AND employee_id = 938
     AND org_department_id = c_osa
     AND effective_from = DATE '2026-04-28'
     AND effective_to   = DATE '2026-07-07';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Предусловие: назначение ОСА Кульдяева (28.04–07.07) не в ожидаемом состоянии';
  END IF;

  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments
   WHERE id = c_kuld_tender
     AND employee_id = 938
     AND org_department_id = c_tender
     AND effective_from = DATE '2026-07-08'
     AND effective_to IS NULL;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Предусловие: открытое назначение Тендерного Кульдяева (с 08.07) не в ожидаемом состоянии';
  END IF;

  ---------------------------------------------------------------------------
  -- ПРАВКИ
  ---------------------------------------------------------------------------

  -- 1. Кульдяев (938): дата возврата 08.07 → 01.07.
  --    Порядок важен (триггер ensure_no_overlapping_employee_assignments):
  --    сначала ужимаем ОСА, потом расширяем Тендерный назад.
  UPDATE public.employee_assignments
     SET effective_to = DATE '2026-06-30', updated_at = now()
   WHERE id = c_kuld_osa AND employee_id = 938;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Шаг 1а: ожидалась 1 строка (ОСА Кульдяева), изменено %', v_cnt;
  END IF;

  UPDATE public.employee_assignments
     SET effective_from = DATE '2026-07-01', updated_at = now()
   WHERE id = c_kuld_tender AND employee_id = 938;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Шаг 1б: ожидалась 1 строка (Тендерный Кульдяева), изменено %', v_cnt;
  END IF;

  -- 2. Узун (1833), Гривапш (475), Оларь (2510), Репников (2511):
  --    закрыть зависшее открытое назначение ОСА на 30.06.
  UPDATE public.employee_assignments
     SET effective_to = DATE '2026-06-30', updated_at = now()
   WHERE id IN ('6940e5f4-c722-4084-a970-2b9b95fcfbaa',
                '353b4c01-3de0-4adf-9c82-47d83d1d3aa8',
                'cc7fa04f-0ae4-46ec-8c6f-8552c8adb4e9',
                '60271aaf-c3cf-4b4d-a10f-a151690be42f')
     AND effective_to IS NULL;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 4 THEN
    RAISE EXCEPTION 'Шаг 2: ожидалось 4 строки (закрытие ОСА), изменено %', v_cnt;
  END IF;

  -- 3. Тем же четверым — открытое назначение в Тендерный с 01.07.
  --    position_id берём из текущего снапшота сотрудника.
  INSERT INTO public.employee_assignments
    (employee_id, org_department_id, position_id, effective_from,
     is_primary, assignment_type, change_reason)
  SELECT e.id, c_tender, e.position_id, DATE '2026-07-01',
         true, 'main',
         'Исправление: возврат из ОСА (перевод 08.07 задним числом не закрыл назначение)'
    FROM public.employees e
   WHERE e.id IN (1833, 475, 2510, 2511);
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 4 THEN
    RAISE EXCEPTION 'Шаг 3: ожидалось 4 вставки (Тендерный с 01.07), вставлено %', v_cnt;
  END IF;

  ---------------------------------------------------------------------------
  -- ПОСТУСЛОВИЯ (до COMMIT)
  ---------------------------------------------------------------------------

  -- У каждого из пятерых ровно одно открытое назначение — Тендерный с 01.07.
  SELECT count(*) INTO v_cnt
    FROM (SELECT employee_id
            FROM public.employee_assignments
           WHERE employee_id IN (938, 1833, 475, 2510, 2511)
             AND effective_to IS NULL
           GROUP BY employee_id
          HAVING count(*) = 1
             AND bool_and(org_department_id = c_tender)
             AND bool_and(effective_from = DATE '2026-07-01')) t;
  IF v_cnt <> 5 THEN
    RAISE EXCEPTION 'Постусловие: не у всех пятерых ровно одно открытое назначение «Тендерный с 01.07» (ок только у %)', v_cnt;
  END IF;

  -- Пересекающихся периодов нет (границы включительно).
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments a
    JOIN public.employee_assignments b
      ON b.employee_id = a.employee_id AND b.id > a.id
   WHERE a.employee_id IN (938, 1833, 475, 2510, 2511)
     AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
      && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Постусловие: найдено % пар пересекающихся назначений', v_cnt;
  END IF;

  -- Снапшот employees.org_department_id совпадает с открытым назначением.
  SELECT count(*) INTO v_cnt
    FROM public.employees e
    JOIN public.employee_assignments ea
      ON ea.employee_id = e.id AND ea.effective_to IS NULL
   WHERE e.id IN (938, 1833, 475, 2510, 2511)
     AND e.org_department_id = ea.org_department_id;
  IF v_cnt <> 5 THEN
    RAISE EXCEPTION 'Постусловие: снапшот отдела совпал с открытым назначением только у % из 5', v_cnt;
  END IF;

  RAISE NOTICE 'Миграция 215: все предусловия/постусловия выполнены (5 сотрудников, Тендерный с 01.07).';
END $$;

COMMIT;

-- Ручная сверка после применения: у каждого из пятерых ровно одно открытое
-- назначение — Тендерный с 01.07; ОСА закрыт 30.06.
--
-- SELECT ea.employee_id, e.full_name, d.name,
--        to_char(ea.effective_from,'YYYY-MM-DD') AS from_d,
--        to_char(ea.effective_to,'YYYY-MM-DD')   AS to_d
--   FROM employee_assignments ea
--   JOIN employees e ON e.id = ea.employee_id
--   LEFT JOIN org_departments d ON d.id = ea.org_department_id
--  WHERE ea.employee_id IN (938, 1833, 475, 2510, 2511)
--  ORDER BY ea.employee_id, ea.effective_from;
--
-- Ожидаемо: по одному NULL-периоду (Тендерный, from 2026-07-01) на сотрудника,
-- пересечений нет. Табель Тендерного за июль показывает всех с 1-го числа,
-- в гриде ОСА за июль их нет. Калинина (3626) проверена — у неё назначения
-- уже корректны (Тендерный открыт с 01.07), правка не нужна.
--
-- Период 16–30 июня (никто из пятерых не подан ни в одном табеле) миграция
-- сознательно НЕ трогает — это отдельная кадрово-табельная корректировка.
