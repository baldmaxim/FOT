-- 244_kpi_premium_scale.sql
-- Шкала премии KPI закрытия КС-2 (приказ, п. 4 и Приложение № 1) — версиями.
--
-- Пункт 8.3 приказа: шкала и премиальная база меняются ОТДЕЛЬНЫМ ПРИКАЗОМ. Поэтому они
-- живут в БД версиями, а не константой в коде: смена базы не должна требовать релиза,
-- а исторический расчёт обязан остаться воспроизводимым.
--
-- ЧТО ЭТА МИГРАЦИЯ НЕ СОЗДАЁТ. Таблиц расчёта премии (ревизии, статусы «Опубликовано/
-- Утверждено», возражения) здесь нет намеренно: в этой итерации премия считается на лету
-- и помечается ПРЕДВАРИТЕЛЬНОЙ. Хранимая копия немедленно разошлась бы с живым расчётом,
-- потому что факт по определению доначисляется задним числом при подписании актов (п. 3.1).
--
-- ВСЕ СУММЫ: numeric(15,2), РУБЛИ, до НДФЛ.
-- max_premium колонкой НЕ хранится — считается как base_amount * max(coefficient).
-- Отдельное поле разошлось бы с точками шкалы при первой же правке.
--
-- ТРЕБУЕТ 241_object_kpi_ks2.sql (user_profiles-конвенция аудит-полей — как там).
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Версии шкалы
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_premium_scale_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Первый месяц действия. CHECK на 1-е число: расчёт всегда ведётся от начала месяца,
  -- дата внутри месяца сделала бы «половину месяца по старой шкале» неопределённой.
  valid_from      date NOT NULL UNIQUE CHECK (EXTRACT(DAY FROM valid_from) = 1),
  base_amount     numeric(15,2) NOT NULL CHECK (base_amount > 0),
  -- Реквизиты приказа: текст (номер и дата) + необязательная ссылка на документ.
  order_reference text,
  order_url       text,
  notes           text,
  created_by      uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.kpi_premium_scale_versions IS
  'Версии шкалы премии KPI КС-2 (п. 8.3). Применённая версия неизменяема — новый приказ = новая версия.';

-- ---------------------------------------------------------------------------
-- 2. Точки шкалы
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_premium_scale_points (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id     uuid NOT NULL REFERENCES public.kpi_premium_scale_versions(id) ON DELETE CASCADE,
  completion_pct numeric(6,2) NOT NULL,
  coefficient    numeric(4,2) NOT NULL CHECK (coefficient >= 0),
  UNIQUE (version_id, completion_pct)
);

-- Порядок точек — рабочая нагрузка интерполяции: две выборки «ближайшая снизу» и
-- «ближайшая сверху» на каждый месяц.
CREATE INDEX IF NOT EXISTS kpi_premium_scale_points_lookup_idx
  ON public.kpi_premium_scale_points (version_id, completion_pct)
  INCLUDE (coefficient);

COMMENT ON TABLE public.kpi_premium_scale_points IS
  'Точки шкалы: процент выполнения -> коэффициент. Между точками — линейная интерполяция (п. 4.3).';

-- ---------------------------------------------------------------------------
-- 3. Иммутабельность применённых версий
-- ---------------------------------------------------------------------------
-- Версионирование без запрета правок — фикция: обычный UPDATE переписал бы уже
-- показанный человеку расчёт задним числом, а ON DELETE CASCADE снёс бы точки.
-- Правка разрешена только версии, месяц действия которой ЕЩЁ НЕ НАСТУПИЛ.
-- OLD и NEW разбираются по TG_OP, а не через COALESCE(OLD, NEW): в DELETE-триггере NEW
-- не назначена, в INSERT-триггере не назначена OLD, и обращение к полю такой записи —
-- ошибка выполнения, а не NULL.
CREATE OR REPLACE FUNCTION public.kpi_premium_scale_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_valid_from date;
  v_version_id uuid;
  v_current_month date := date_trunc('month', (now() AT TIME ZONE 'Europe/Moscow'))::date;
BEGIN
  IF TG_TABLE_NAME = 'kpi_premium_scale_versions' THEN
    IF TG_OP = 'DELETE' THEN
      v_valid_from := OLD.valid_from;
    ELSE
      v_valid_from := NEW.valid_from;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      v_version_id := OLD.version_id;
    ELSE
      v_version_id := NEW.version_id;
    END IF;

    SELECT v.valid_from INTO v_valid_from
      FROM public.kpi_premium_scale_versions v
     WHERE v.id = v_version_id;
  END IF;

  -- Версия удаляется каскадом (значит, она ещё не наступила) — точки уходят вместе с ней.
  IF v_valid_from IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_valid_from <= v_current_month THEN
    RAISE EXCEPTION
      'Шкала премии, действующая с %, уже применена и не может быть изменена. Заведите новую версию.',
      to_char(v_valid_from, 'DD.MM.YYYY')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kpi_premium_scale_versions_guard ON public.kpi_premium_scale_versions;
CREATE TRIGGER kpi_premium_scale_versions_guard
  BEFORE UPDATE OR DELETE ON public.kpi_premium_scale_versions
  FOR EACH ROW EXECUTE FUNCTION public.kpi_premium_scale_guard();

DROP TRIGGER IF EXISTS kpi_premium_scale_points_guard ON public.kpi_premium_scale_points;
CREATE TRIGGER kpi_premium_scale_points_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.kpi_premium_scale_points
  FOR EACH ROW EXECUTE FUNCTION public.kpi_premium_scale_guard();

-- ---------------------------------------------------------------------------
-- 4. Стартовая версия (Приложение № 1 приказа)
-- ---------------------------------------------------------------------------
-- valid_from = 01.08.2026: месяцы до вступления шкалы в силу премии не получают
-- (статус no_scale). Обратной силы у шкалы нет — это решение, а не техническая деталь.
--
-- Вставка идёт ДО создания триггеров? Нет: триггеры BEFORE INSERT стоят только на точках,
-- и для них условие проверяется по valid_from версии. Стартовая версия наступает
-- 01.08.2026, поэтому при применении миграции в августе 2026 и позже INSERT точек
-- заблокировался бы. Отсюда порядок: сид выполняется с временно отключённым триггером.
ALTER TABLE public.kpi_premium_scale_points DISABLE TRIGGER kpi_premium_scale_points_guard;

WITH seed AS (
  INSERT INTO public.kpi_premium_scale_versions (valid_from, base_amount, order_reference, notes)
  VALUES (
    DATE '2026-08-01',
    200000.00,
    'Приказ об утверждении KPI и порядка начисления ежемесячной премии руководителям строительства за закрытие КС-2, Приложение № 1',
    'Стартовая шкала. Максимальная премия = 200 000 x 1,50 = 300 000 руб. до НДФЛ.'
  )
  ON CONFLICT (valid_from) DO NOTHING
  RETURNING id
)
INSERT INTO public.kpi_premium_scale_points (version_id, completion_pct, coefficient)
SELECT s.id, p.pct, p.coef
  FROM seed s
  CROSS JOIN (VALUES
    (80.00,  0.00),
    (85.00,  0.25),
    (90.00,  0.50),
    (95.00,  0.80),
    (100.00, 1.00),
    (105.00, 1.25),
    (110.00, 1.50)
  ) AS p(pct, coef)
ON CONFLICT (version_id, completion_pct) DO NOTHING;

ALTER TABLE public.kpi_premium_scale_points ENABLE TRIGGER kpi_premium_scale_points_guard;

-- ---------------------------------------------------------------------------
-- 5. Доступ
-- ---------------------------------------------------------------------------
-- RLS не включаем — по тем же причинам, что в разделе 9 миграции 241: ролей anon/
-- authenticated в этой БД нет, FORCE RLS без политик отрезал бы владельца.
-- NOTIFY pgrst не ставим: PostgREST в этой БД нет.
REVOKE ALL ON TABLE public.kpi_premium_scale_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.kpi_premium_scale_points   FROM PUBLIC;

COMMIT;
