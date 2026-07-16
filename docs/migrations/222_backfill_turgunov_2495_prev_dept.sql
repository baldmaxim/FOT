-- 222_backfill_turgunov_2495_prev_dept.sql
-- Восстановление прежнего отдела Тургунова Махаммаджон Холдарали Угли (emp 2495)
-- перед переводом в бр.Амонов Акмалжон М. с 01.07.2026.
--
-- Что произошло: 15.07.2026 Белоконь перевела Тургунова (Управление кадрами →
-- «Сменить отдел») из бр.Амонов А.М (be0c5bfa) в бр.Амонов Акмалжон М. (cac1f75d)
-- задним числом с 01.07. Тургунов был «snapshot-only» (без строк employee_assignments),
-- поэтому changeDepartment вставил ТОЛЬКО новую строку (01.07), а прежний отдел строкой
-- не записал. Итог: табель за июнь показывал его у Макшанова (протечка snapshot), а у
-- Стеняева (прежняя бригада) — не показывал вовсе.
--
-- Прежний отдел взят из аудита MOVE_EMPLOYEE_DEPARTMENT #115693 (from_department_id =
-- be0c5bfa). Восстанавливаем закрытый период прежнего отдела [01.05.2026 .. 30.06.2026]
-- (01.05 — дата найма; 30.06 — день перед переводом). Получается корректная пара:
-- be0c5bfa [.. 30.06] + cac1f75d [01.07 .. открыт].
--
-- Порядок выкладки: СНАЧАЛА задеплоить бэкенд с фиксом резолвера (Часть 1) и
-- changeDepartment (Часть 2), ПОТОМ эта миграция, затем сбросить кэш табеля (рестарт).
--
-- Отделы:
--   бр.Амонов А.М           be0c5bfa-7683-4fa9-88ed-f81052019ccd  (прежний, Стеняев)
--   бр.Амонов Акмалжон М.   cac1f75d-f565-469f-ad40-b498ca5211aa  (новый, Макшанов)
--
-- Идемпотентно: если ожидаемая строка прежнего отдела уже есть — NOTICE и выход.
-- Любое иное состояние → RAISE EXCEPTION → ROLLBACK всей транзакции ДО фиксации.

BEGIN;

DO $$
DECLARE
  c_emp     CONSTANT integer := 2495;
  c_old     CONSTANT uuid := 'be0c5bfa-7683-4fa9-88ed-f81052019ccd'; -- прежний (Стеняев)
  c_new     CONSTANT uuid := 'cac1f75d-f565-469f-ad40-b498ca5211aa'; -- новый (Макшанов)
  c_from    CONSTANT date := DATE '2026-05-01'; -- дата найма
  c_to      CONSTANT date := DATE '2026-06-30'; -- день перед переводом
  v_cnt     integer;
  v_pos     uuid;
BEGIN
  ---------------------------------------------------------------------------
  -- ПРЕДУСЛОВИЯ
  ---------------------------------------------------------------------------

  -- Сотрудник существует, активен, snapshot = новый отдел, дата найма ожидаемая.
  SELECT count(*) INTO v_cnt
    FROM public.employees
   WHERE id = c_emp
     AND employment_status = 'active'
     AND is_archived = false
     AND org_department_id = c_new
     AND hire_date::date = c_from;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Предусловие: emp % не в ожидаемом состоянии (active, snapshot=новый, hire=%)', c_emp, c_from;
  END IF;

  -- Идемпотентность: ожидаемая закрытая строка прежнего отдела уже есть → успех, выходим.
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments
   WHERE employee_id = c_emp
     AND org_department_id = c_old
     AND effective_from = c_from
     AND effective_to   = c_to;
  IF v_cnt = 1 THEN
    RAISE NOTICE 'Миграция 222: строка прежнего отдела уже существует — идемпотентный успех.';
    RETURN;
  END IF;

  -- Любая ДРУГАЯ строка прежнего отдела у сотрудника → неожиданно, откат.
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments
   WHERE employee_id = c_emp
     AND org_department_id = c_old;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Предусловие: у emp % уже есть % строк прежнего отдела в неожиданном состоянии', c_emp, v_cnt;
  END IF;

  -- Ровно одна открытая строка — новый отдел с 01.07. Из неё берём position_id.
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments
   WHERE employee_id = c_emp
     AND effective_to IS NULL;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Предусловие: ожидалась ровно 1 открытая строка у emp %, найдено %', c_emp, v_cnt;
  END IF;

  SELECT position_id INTO v_pos
    FROM public.employee_assignments
   WHERE employee_id = c_emp
     AND org_department_id = c_new
     AND effective_from = DATE '2026-07-01'
     AND effective_to IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Предусловие: открытая строка нового отдела (cac1f75d, с 01.07) не найдена у emp %', c_emp;
  END IF;

  ---------------------------------------------------------------------------
  -- ПРАВКА
  ---------------------------------------------------------------------------

  INSERT INTO public.employee_assignments
    (employee_id, org_department_id, position_id, effective_from, effective_to,
     is_primary, assignment_type, change_reason)
  VALUES
    (c_emp, c_old, v_pos, c_from, c_to, true, 'main',
     'Бэкфилл: прежний отдел до перевода 01.07 (audit 115693)');
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Правка: ожидалась 1 вставка прежнего отдела, вставлено %', v_cnt;
  END IF;

  ---------------------------------------------------------------------------
  -- ПОСТУСЛОВИЯ (до COMMIT)
  ---------------------------------------------------------------------------

  -- Пересекающихся периодов нет (границы включительно) — то же, что проверяет
  -- триггер ensure_no_overlapping_employee_assignments.
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments a
    JOIN public.employee_assignments b
      ON b.employee_id = a.employee_id AND b.id > a.id
   WHERE a.employee_id = c_emp
     AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
      && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Постусловие: найдено % пар пересекающихся назначений у emp %', v_cnt, c_emp;
  END IF;

  -- Корректная пара: закрытая прежний отдел по 30.06 + открытая новый с 01.07.
  SELECT count(*) INTO v_cnt
    FROM public.employee_assignments
   WHERE employee_id = c_emp
     AND ((org_department_id = c_old AND effective_from = c_from AND effective_to = c_to)
       OR (org_department_id = c_new AND effective_from = DATE '2026-07-01' AND effective_to IS NULL));
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'Постусловие: ожидалась пара (be0c5bfa .. 30.06 + cac1f75d 01.07..), собрано %', v_cnt;
  END IF;

  RAISE NOTICE 'Миграция 222: прежний отдел emp % восстановлен (be0c5bfa 01.05–30.06).', c_emp;
END $$;

COMMIT;

-- Ручная сверка после применения:
-- SELECT ea.employee_id, e.full_name, d.name,
--        to_char(ea.effective_from,'YYYY-MM-DD') AS from_d,
--        to_char(ea.effective_to,'YYYY-MM-DD')   AS to_d
--   FROM employee_assignments ea
--   JOIN employees e ON e.id = ea.employee_id
--   LEFT JOIN org_departments d ON d.id = ea.org_department_id
--  WHERE ea.employee_id = 2495
--  ORDER BY ea.effective_from;
--
-- Ожидаемо: be0c5bfa [2026-05-01 .. 2026-06-30] + cac1f75d [2026-07-01 .. NULL].
-- Табель: июнь/уч.Стеняев (be0c5bfa) показывает Тургунова, июнь/уч.Макшанов (cac1f75d) — нет,
-- июль/уч.Макшанов — показывает. После применения сбросить кэш табеля (рестарт бэкенда).
