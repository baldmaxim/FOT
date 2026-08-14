-- 243_object_ks6_entries.sql
-- Реестр КС-6 (журнал учёта выполненных работ) по объектам строительства.
--
-- КС-6 — СПРАВОЧНАЯ ВЕЛИЧИНА. В расчёт приказа она НЕ входит: ни в стоимость договора,
-- ни в остаток, ни в план месяца, ни в факт, ни в процент выполнения. KPI считается по
-- подписанным КС-2 (п. 3.1). Единственное назначение таблицы — колонка отчёта рядом
-- с «КС-2», чтобы видеть разрыв «выполнено по журналу / закрыто актами». Любая попытка
-- завести КС-6 в формулу плана — изменение методики приказа, а не доработка модуля.
--
-- ВСЕ СУММЫ: numeric(15,2), РУБЛИ, С НДС — как в 241.
-- entry_kind, как у КС-2, здесь НЕ вводится: в КС-2 он носитель знака (CHECK знака,
-- третье поле UNIQUE, разбивка fact_acts/fact_reductions), а КС-6 не участвует ни в одной
-- формуле. Сумма только положительная, ошибочная запись аннулируется, а не заводится минусом.
--
-- ТРЕБУЕТ 241_object_kpi_ks2.sql: составной FK смотрит в object_contracts(id, skud_object_id),
-- и CHECK на object_kpi_history расширяется здесь же. Применять СТРОГО после 241.
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Записи КС-6
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.object_ks6_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id          uuid NOT NULL,
  skud_object_id       uuid NOT NULL,
  amount               numeric(15,2) NOT NULL CHECK (amount > 0),
  doc_number           text NOT NULL CHECK (btrim(doc_number) <> ''),
  -- Дата подписания ЗАКАЗЧИКОМ — по ней определяется отчётный месяц колонки, так же
  -- как у КС-2 (п. 3.1).
  --
  -- Тип обязан остаться date. При смене на timestamptz generated-колонка ниже станет
  -- невозможной, а границы месяцев уедут на 3 часа (МСК).
  customer_signed_date date NOT NULL,
  -- ::timestamp обязателен. У date_trunc четыре перегрузки, и для аргумента date
  -- разрешение выбирает date_trunc(text, timestamptz) — она STABLE, а generated-выражение
  -- обязано быть IMMUTABLE. Без каста DDL падает: generation expression is not immutable.
  period_month         date GENERATED ALWAYS AS
                         (date_trunc('month', customer_signed_date::timestamp)::date) STORED,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','signed','cancelled')),
  notes                text,
  version              bigint NOT NULL DEFAULT 1,
  created_by           uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by           uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Тот же составной FK, что у КС-2: запись не может ссылаться на договор объекта A,
  -- числясь на объекте B.
  FOREIGN KEY (contract_id, skud_object_id)
    REFERENCES public.object_contracts(id, skud_object_id) ON DELETE RESTRICT
);

COMMENT ON TABLE public.object_ks6_entries IS
  'Реестр КС-6. СПРАВОЧНАЯ колонка отчёта: в план, остаток и факт KPI не входит (приказ считает по КС-2).';

-- Частичный (аннулированная запись освобождает номер) и нормализованный: без
-- lower(btrim(...)) «КС6-1», «кс6-1» и «КС6-1 » прошли бы как разные и удвоили справочную
-- колонку — не ошибка, а неверные цифры на экране.
CREATE UNIQUE INDEX IF NOT EXISTS object_ks6_entries_number_uq
  ON public.object_ks6_entries (contract_id, lower(btrim(doc_number)))
  WHERE status <> 'cancelled';

-- Рабочая лошадка отчёта. Ключ по customer_signed_date (а не period_month): фильтр окна
-- в OBJECT_KPI_REPORT_SQL пишется полуинтервалом именно по ней, period_month — из INCLUDE.
CREATE INDEX IF NOT EXISTS object_ks6_entries_report_idx
  ON public.object_ks6_entries (skud_object_id, customer_signed_date)
  INCLUDE (amount, period_month)
  WHERE status = 'signed';

CREATE INDEX IF NOT EXISTS object_ks6_entries_contract_idx
  ON public.object_ks6_entries (contract_id, customer_signed_date);

-- ---------------------------------------------------------------------------
-- 2. Журнал изменений: новый вид сущности
-- ---------------------------------------------------------------------------
-- В 241 CHECK записан колоночным, поэтому имя автоматическое —
-- object_kpi_history_entity_kind_check. ADD CONSTRAINT IF NOT EXISTS в PostgreSQL нет,
-- идемпотентность даёт пара DROP IF EXISTS + ADD. Валидация существующих строк проходит:
-- 'ks6' только добавляется, старые значения остаются разрешёнными.
ALTER TABLE public.object_kpi_history
  DROP CONSTRAINT IF EXISTS object_kpi_history_entity_kind_check;

ALTER TABLE public.object_kpi_history
  ADD CONSTRAINT object_kpi_history_entity_kind_check
  CHECK (entity_kind IN ('contract','addendum','ks2','ks6','assignment','global_role','plan'));

-- ---------------------------------------------------------------------------
-- 3. Доступ
-- ---------------------------------------------------------------------------
-- RLS не включаем — по тем же причинам, что в разделе 9 миграции 241: ролей anon/
-- authenticated в этой БД нет, а FORCE RLS без политик отрезал бы владельца. Доступ
-- только через сервисную роль бэкенда, авторизация — в middleware.
-- NOTIFY pgrst не ставим: PostgREST в этой БД нет (241 это прямо оговаривает).
REVOKE ALL ON TABLE public.object_ks6_entries FROM PUBLIC;

COMMIT;
