-- 246_kpi_premium_scale_from_start.sql
-- Шкала премии KPI КС-2 начинает действовать с начала расчёта, а не с 01.08.2026.
--
-- ПОЧЕМУ. В 244 стартовая версия заведена с 01.08.2026, и все накопленные месяцы (январь–июль
-- 2026) получали статус no_scale: план и факт показаны, а коэффициент — прочерк, премия не
-- рассчитана, итоги периода нулевые. Дата вступления приказа в силу в самом приказе не
-- проставлена, а проверять расчёт нужно именно на накопленной истории. Поэтому действие
-- стартовой версии распространяется на всю историю: valid_from = 01.01.2020.
--
-- 244 НЕ ПРАВИТСЯ: она уже в main и на стороннем окружении могла быть применена.
--
-- ПОЧЕМУ НЕ ГОЛЫЙ UPDATE. Запущенный до 244 или на изменённой вручную шкале он тронул бы ноль
-- строк и завершился успехом — нарушение порядка выката осталось бы незамеченным. Поэтому
-- состояние сначала распознаётся, и в любом непонятном случае миграция падает.
--
-- ТРЕБУЕТ 244_kpi_premium_scale.sql. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

DO $$
DECLARE
  v_id      uuid;
  v_base    numeric;
  v_from    date;
  v_matches int;
  v_total   int;
BEGIN
  -- Самая частая ошибка выката — запуск не в том порядке. Без этой проверки PostgreSQL
  -- ответил бы «relation does not exist», по которому причина не читается.
  IF to_regclass('public.kpi_premium_scale_versions') IS NULL
     OR to_regclass('public.kpi_premium_scale_points') IS NULL THEN
    RAISE EXCEPTION
      'Таблиц шкалы премии нет — сначала примените 244_kpi_premium_scale.sql, затем эту миграцию';
  END IF;

  -- Эталонный состав приложения № 1. Проверяется в ОБЕИХ ветках — и при переносе, и при
  -- повторном запуске: иначе вручную изменённая шкала сойдёт за «уже перенесённую».
  CREATE TEMP TABLE expected_points (completion_pct numeric, coefficient numeric) ON COMMIT DROP;
  INSERT INTO expected_points VALUES
    (80, 0.00), (85, 0.25), (90, 0.50), (95, 0.80), (100, 1.00), (105, 1.25), (110, 1.50);

  SELECT id, base_amount, valid_from INTO v_id, v_base, v_from
    FROM public.kpi_premium_scale_versions
   WHERE valid_from = DATE '2020-01-01';

  IF v_id IS NOT NULL THEN
    -- Повторный запуск. Старой версии рядом быть не должно: две стартовые шкалы означают
    -- ручное вмешательство, а не идемпотентность.
    IF EXISTS (SELECT 1 FROM public.kpi_premium_scale_versions WHERE valid_from = DATE '2026-08-01') THEN
      RAISE EXCEPTION
        'Рядом с перенесённой версией существует версия шкалы от 01.08.2026 — разберитесь вручную';
    END IF;
  ELSE
    SELECT id, base_amount, valid_from INTO v_id, v_base, v_from
      FROM public.kpi_premium_scale_versions
     WHERE valid_from = DATE '2026-08-01';

    IF v_id IS NULL THEN
      RAISE EXCEPTION
        'Не найдена версия шкалы от 01.08.2026 — сначала примените 244_kpi_premium_scale.sql';
    END IF;
  END IF;

  IF v_base IS DISTINCT FROM 200000.00 THEN
    RAISE EXCEPTION 'База шкалы изменена вручную (%) — перенос даты остановлен', v_base;
  END IF;

  SELECT count(*) INTO v_matches
    FROM public.kpi_premium_scale_points p
    JOIN expected_points e
      ON e.completion_pct = p.completion_pct
     AND e.coefficient    = p.coefficient
   WHERE p.version_id = v_id;

  SELECT count(*) INTO v_total
    FROM public.kpi_premium_scale_points
   WHERE version_id = v_id;

  IF v_matches <> 7 OR v_total <> 7 THEN
    RAISE EXCEPTION
      'Точки шкалы отличаются от приложения № 1 приказа (совпало % из %) — перенос даты остановлен',
      v_matches, v_total;
  END IF;

  IF v_from = DATE '2020-01-01' THEN
    RAISE NOTICE 'Шкала уже действует с 01.01.2020 — изменений не требуется';
    RETURN;
  END IF;

  -- Триггер иммутабельности снимается ТОЛЬКО на время этой правки и возвращается сразу же:
  -- защита применённых версий остаётся в силе для всех остальных операций.
  EXECUTE 'ALTER TABLE public.kpi_premium_scale_versions DISABLE TRIGGER kpi_premium_scale_versions_guard';

  UPDATE public.kpi_premium_scale_versions
     SET valid_from = DATE '2020-01-01',
         notes = COALESCE(notes, '')
                 || ' Действие распространено на всю историю расчёта миграцией 246.',
         updated_at = now()
   WHERE id = v_id;

  EXECUTE 'ALTER TABLE public.kpi_premium_scale_versions ENABLE TRIGGER kpi_premium_scale_versions_guard';

  RAISE NOTICE 'Шкала премии перенесена на 01.01.2020';
END $$;

COMMIT;
