-- 241_object_kpi_ks2.sql
-- KPI закрытия КС-2 для руководителей строительства (Этап 1: данные и расчёт, без премии).
-- Приказ «Об утверждении KPI и порядка начисления ежемесячной премии руководителям
-- строительства за закрытие КС-2» назначает портал ФОТ источником расчёта (п. 5).
--
-- ВСЕ СУММЫ: numeric(15,2), РУБЛИ, С НДС (п. 2.1). Колонки валюты нет.
-- Вся арифметика денег выполняется в PostgreSQL на numeric — драйвер отдаёт numeric
-- строкой, и сложение в JS склеило бы строки.
--
-- Справочник объектов — ТОЛЬКО public.skud_objects. Названия, карты и точки доступа
-- здесь не дублируются. employee_skud_object_access («место работы» для СКУД) в KPI-контуре
-- НЕ используется как источник закреплений: у неё нет периода и она участвует в правах
-- на табель. Разовый импорт делает scripts/import-kpi-assignments-from-skud.ts.
--
-- Миграция строго аддитивна: шесть новых таблиц + одна колонка в production_calendar.
-- Существующие таблицы и связи не изменяются — это условие безопасного отката.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- btree_gist нужен для EXCLUDE, где uuid/text сравниваются по =, а период — по &&.
-- На проде уже установлено (в схеме public); строка идемпотентна и оставлена для чистых
-- окружений. БЕЗ «WITH SCHEMA extensions»: схемы extensions в этой БД нет, и на чистом
-- окружении такая форма уронила бы DDL.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. Договор на объект
-- ---------------------------------------------------------------------------
-- UNIQUE(skud_object_id) БЕЗ условия is_active — намеренно. Частичный уникальный
-- индекс разрешал бы сколько угодно неактивных договоров рядом с активным, и акты
-- старого договора начали бы считаться против базы нового. Версионирования договоров
-- в MVP нет, поэтому состояния «несколько договоров на объект» не должно существовать
-- физически. is_active означает «договор закрыт/не ведётся», на уникальность не влияет.
CREATE TABLE IF NOT EXISTS public.object_contracts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skud_object_id     uuid NOT NULL REFERENCES public.skud_objects(id) ON DELETE RESTRICT,
  contract_number    text,
  contract_date      date,
  customer_name      text,
  -- Базовая стоимость договора. Допсоглашения её НЕ правят — они лежат отдельными
  -- строками в object_contract_addenda, иначе история изменений стоимости теряется.
  base_amount        numeric(15,2) NOT NULL CHECK (base_amount >= 0),
  planned_zos_date   date,
  actual_zos_date    date,
  -- Первый расчётный месяц. NULL = «с начала запрошенного окна». Без него объект,
  -- договор по которому подписан позже, дал бы десятки строк с 0 % и утянул сводную оценку.
  plan_start_month   date,
  -- Вне приказа, для справочной колонки численности.
  planned_headcount  integer,
  -- ВНИМАНИЕ: снятие is_active убирает договор из отчёта, и месяцы БЕЗ зафиксированного
  -- снимка плана уедут в data_incomplete задним числом (contract_total станет NULL).
  -- Для договора с историей это не «архивирование», а потеря показателей: закрывать
  -- объект следует через actual_zos_date, а is_active трогать только у ошибочных записей.
  is_active          boolean NOT NULL DEFAULT true,
  notes              text,
  version            bigint NOT NULL DEFAULT 1,
  created_by         uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (plan_start_month IS NULL OR EXTRACT(DAY FROM plan_start_month) = 1),
  CONSTRAINT object_contracts_object_uq UNIQUE (skud_object_id),
  -- Цель составного FK из object_ks2_entries: акт не может ссылаться на договор
  -- объекта A, числясь на объекте B.
  CONSTRAINT object_contracts_id_object_uq UNIQUE (id, skud_object_id)
);

-- Покрывающий индекс под сводный отчёт: Index Only Scan без обращения к куче.
CREATE INDEX IF NOT EXISTS object_contracts_report_idx
  ON public.object_contracts (skud_object_id)
  INCLUDE (base_amount, planned_zos_date, actual_zos_date, planned_headcount, plan_start_month);

-- ---------------------------------------------------------------------------
-- 2. Допсоглашения
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.object_contract_addenda (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id      uuid NOT NULL REFERENCES public.object_contracts(id) ON DELETE RESTRICT,
  addendum_number  text NOT NULL CHECK (btrim(addendum_number) <> ''),
  addendum_date    date NOT NULL,
  -- Дата вступления в силу. Граница учёта: effective_date <= 1-е число расчётного месяца,
  -- то есть ДС, действующий с 1-го числа, входит в план ЭТОГО месяца, а ДС от 2-го числа
  -- и позже — в план следующего (п. 2.2 + п. 2.8: план закрытого месяца не пересчитывается).
  effective_date   date NOT NULL,
  amount_delta     numeric(15,2) NOT NULL CHECK (amount_delta <> 0),  -- отрицательное допустимо
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','signed','cancelled')),  -- в расчёт только signed (п. 3.2)
  notes            text,
  version          bigint NOT NULL DEFAULT 1,
  created_by       uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Частичный (аннулированный ДС освобождает номер для исправленного) и нормализованный:
-- без lower(btrim(...)) номера «ДС-1», «дс-1» и «ДС-1 » прошли бы как разные и удвоили
-- стоимость договора. Тихий класс дефектов — ошибки не будет, будут неверные деньги.
CREATE UNIQUE INDEX IF NOT EXISTS object_contract_addenda_number_uq
  ON public.object_contract_addenda (contract_id, lower(btrim(addendum_number)))
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS object_contract_addenda_signed_idx
  ON public.object_contract_addenda (contract_id, effective_date)
  INCLUDE (amount_delta)
  WHERE status = 'signed';

-- ---------------------------------------------------------------------------
-- 3. Подписанные КС-2 и уменьшения объёма
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.object_ks2_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id          uuid NOT NULL,
  skud_object_id       uuid NOT NULL,
  entry_kind           text NOT NULL CHECK (entry_kind IN ('act','reduction')),  -- reduction = п. 3.3
  amount               numeric(15,2) NOT NULL,
  act_number           text NOT NULL CHECK (btrim(act_number) <> ''),
  -- Дата подписания ЗАКАЗЧИКОМ — по ней определяется расчётный месяц (п. 3.1),
  -- а не по дате составления акта.
  --
  -- Тип обязан остаться date. При смене на timestamptz generated-колонка ниже станет
  -- невозможной, а границы месяцев уедут на 3 часа: акт, подписанный 01.08 в 00:30 МСК,
  -- попал бы в июль.
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
  -- Формулы полагаются на отрицательность уменьшений: одна запись reduction со знаком
  -- плюс тихо завысила бы и факт месяца, и накопительный объём.
  CHECK ((entry_kind = 'act' AND amount > 0) OR (entry_kind = 'reduction' AND amount < 0)),
  FOREIGN KEY (contract_id, skud_object_id)
    REFERENCES public.object_contracts(id, skud_object_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS object_ks2_entries_act_uq
  ON public.object_ks2_entries (contract_id, lower(btrim(act_number)), entry_kind)
  WHERE status <> 'cancelled';

-- Рабочая лошадка отчёта. Ключ по customer_signed_date (а не period_month), потому что
-- фильтр окна пишется полуинтервалом именно по ней; period_month читается из INCLUDE.
CREATE INDEX IF NOT EXISTS object_ks2_entries_report_idx
  ON public.object_ks2_entries (skud_object_id, customer_signed_date)
  INCLUDE (amount, entry_kind, period_month)
  WHERE status = 'signed';

CREATE INDEX IF NOT EXISTS object_ks2_entries_contract_idx
  ON public.object_ks2_entries (contract_id, customer_signed_date);

-- ---------------------------------------------------------------------------
-- 4. Закрепление объекта за руководителем / экономистом (с периодом)
-- ---------------------------------------------------------------------------
-- Почему отдельная таблица, а не employee_skud_object_access: приказ требует периода
-- ответственности (п. 5.1, 6.4), а та таблица дат не имеет, означает «место работы»
-- и участвует в разграничении доступа к табелям. Это разные сущности.
CREATE TABLE IF NOT EXISTS public.object_kpi_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skud_object_id uuid    NOT NULL REFERENCES public.skud_objects(id) ON DELETE RESTRICT,
  -- integer, а не bigint: employees.id — integer, и вся кодовая база ссылается на него
  -- как INTEGER (миграции 171, 238). Разнотипный FK работает, но ломает единообразие.
  employee_id    integer NOT NULL REFERENCES public.employees(id)    ON DELETE RESTRICT,
  role_kind      text    NOT NULL CHECK (role_kind IN ('construction_manager','object_economist')),
  valid_from     date   NOT NULL,
  valid_to       date   NULL,
  -- Происхождение записи: разовый импорт из СКУД помечается отдельно, чтобы его
  -- всегда можно было отличить от ручного закрепления и при нужде откатить.
  source         text   NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual','skud_import')),
  notes          text,
  version        bigint NOT NULL DEFAULT 1,
  created_by     uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- Констрейнт ЧАСТИЧНЫЙ: двух руководителей на объекте одновременно быть не может,
  -- экономистов — сколько угодно. Вариант «role_kind WITH =» запретил бы и второе.
  -- daterange с valid_to IS NULL даёт неограниченный сверху диапазон, COALESCE не нужен.
  CONSTRAINT object_kpi_assignments_manager_no_overlap EXCLUDE USING gist (
    skud_object_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (role_kind = 'construction_manager')
);

CREATE INDEX IF NOT EXISTS object_kpi_assignments_employee_idx
  ON public.object_kpi_assignments (employee_id, role_kind);

CREATE INDEX IF NOT EXISTS object_kpi_assignments_object_idx
  ON public.object_kpi_assignments (skud_object_id, role_kind, valid_from)
  INCLUDE (valid_to, employee_id);

-- ---------------------------------------------------------------------------
-- 5. Глобальные роли KPI (без привязки к объекту)
-- ---------------------------------------------------------------------------
-- «Руководитель экономического отдела» — внесистемная роль: system_role_id у пользователя
-- один, и выдача ему роли «Экономист» отобрала бы текущую (табель, заявления и прочее).
-- Персональных грантов на страницы в модели прав нет, поэтому доступ выдаётся авто-грантом
-- по факту наличия активной записи здесь (см. access-control.service.ts).
--
-- Почему отдельная таблица, а не skud_object_id IS NULL в object_kpi_assignments:
-- весь отчётный SQL и EXCLUDE исходят из NOT NULL; nullable потребовал бы
-- «WHERE skud_object_id IS NOT NULL» в каждом join, и пропуск в одном месте дал бы
-- тихо неверные деньги.
CREATE TABLE IF NOT EXISTS public.object_kpi_global_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id integer NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  role_kind   text    NOT NULL CHECK (role_kind IN ('economics_head')),
  valid_from  date   NOT NULL,
  valid_to    date   NULL,
  notes       text,
  version     bigint NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT object_kpi_global_roles_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    role_kind   WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  )
);

-- По нему грузится кэш активных ролей.
CREATE INDEX IF NOT EXISTS object_kpi_global_roles_kind_idx
  ON public.object_kpi_global_roles (role_kind, valid_from)
  INCLUDE (employee_id, valid_to);

-- ---------------------------------------------------------------------------
-- 6. Зафиксированный план месяца (п. 2.8) — append-only ревизии
-- ---------------------------------------------------------------------------
-- Снимок, а не вычисление. Правка после фиксации НЕ перезаписывает строку: старая
-- ревизия остаётся с is_current=false, добавляется новая. Иначе утверждённый расчёт
-- премии невозможно перепроверить постфактум.
CREATE TABLE IF NOT EXISTS public.object_kpi_month_plans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skud_object_id         uuid NOT NULL REFERENCES public.skud_objects(id) ON DELETE RESTRICT,
  period_month           date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  revision               integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  is_current             boolean NOT NULL DEFAULT true,

  -- Семёрка замороженных величин. Берутся ЛИБО все семь из снимка, ЛИБО все семь
  -- пересчётом — атомарно, иначе в строке перестанет сходиться
  -- remainder / months_remaining = plan_amount.
  contract_total         numeric(15,2),
  ks2_cumulative_before  numeric(15,2),
  remainder              numeric(15,2),
  planned_zos_date_used  date,
  control_date           date,
  months_remaining       integer CHECK (months_remaining >= 1),  -- NULL при data_incomplete

  -- Расчёт формулы и ручное значение разделены: иначе первоначальная расчётная сумма
  -- осталась бы только внутри JSON аудита.
  calculated_plan_amount numeric(15,2) CHECK (calculated_plan_amount >= 0),
  override_plan_amount   numeric(15,2) CHECK (override_plan_amount   >= 0),
  plan_amount            numeric(15,2)
                         GENERATED ALWAYS AS (COALESCE(override_plan_amount, calculated_plan_amount)) STORED,

  status                 text NOT NULL CHECK (status IN ('open','fixed','corrected','data_incomplete')),
  fixed_at               timestamptz,
  fixed_by               uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  fixed_source           text CHECK (fixed_source IN ('auto','manual','economics_head_override')),
  correction_reason      text,
  superseded_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),

  -- data_incomplete хранится с NULL, а НЕ с нулём: ноль в знаменателе совокупного KPI
  -- занижал бы процент руководителя за месяцы, где данных просто не было. Такая строка
  -- исключается и из Σfact, и из Σplan.
  CHECK (status <> 'data_incomplete' OR calculated_plan_amount IS NULL),
  -- Ручное значение требует основания на уровне БД, а не только валидации в контроллере.
  CHECK (override_plan_amount IS NULL OR btrim(COALESCE(correction_reason, '')) <> ''),
  CONSTRAINT object_kpi_month_plans_revision_uq UNIQUE (skud_object_id, period_month, revision)
);

-- Ровно одна текущая ревизия на (объект, месяц). Это КОРРЕКТНОСТЬ, а не скорость:
-- дубль текущего снимка не дал бы ошибки — он удвоил бы строку и итоги отчёта.
CREATE UNIQUE INDEX IF NOT EXISTS object_kpi_month_plans_current_uq
  ON public.object_kpi_month_plans (skud_object_id, period_month)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS object_kpi_month_plans_period_idx
  ON public.object_kpi_month_plans (period_month)
  WHERE is_current;

-- ---------------------------------------------------------------------------
-- 7. Единый журнал изменений
-- ---------------------------------------------------------------------------
-- Шесть разнородных сущностей, поэтому снапшот в jsonb, а не колонками (в отличие
-- от эталона 238, где сущность одна). Прецедент — metadata jsonb в timesheet_approval_events.
CREATE TABLE IF NOT EXISTS public.object_kpi_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skud_object_id  uuid,                    -- NULL для global_role: она не привязана к объекту
  entity_kind     text NOT NULL CHECK (entity_kind IN
                    ('contract','addendum','ks2','assignment','global_role','plan')),
  entity_id       uuid,                    -- БЕЗ FK: история переживает удаление записи
  action          text NOT NULL CHECK (action IN ('create','update','delete')),
  changed_fields  text[] NOT NULL DEFAULT '{}',
  before_data     jsonb,
  after_data      jsonb,
  reason          text,                    -- обязателен для правок после фиксации (п. 2.8, 5.4)
  changed_by      uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  changed_by_name text,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS object_kpi_history_object_idx
  ON public.object_kpi_history (skud_object_id, changed_at DESC);

-- Отдельный индекс: у global_role объекта нет, и по первому индексу такие строки
-- не найти.
CREATE INDEX IF NOT EXISTS object_kpi_history_kind_idx
  ON public.object_kpi_history (entity_kind, changed_at DESC);

-- ---------------------------------------------------------------------------
-- 8. Производственный календарь: перенесённые рабочие выходные
-- ---------------------------------------------------------------------------
-- Срок фиксации плана — N-й рабочий день месяца. Правила «не суббота/воскресенье и
-- не праздник» недостаточно: календарь хранит norm_days, holidays, mandatory_holidays,
-- pre_holidays, но НЕ содержит перенесённых рабочих суббот. В месяце с переносом
-- вычисленный день разошёлся бы с официальным календарём.
ALTER TABLE public.production_calendar
  ADD COLUMN IF NOT EXISTS working_weekends date[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- 9. Защита денежных таблиц от прямого доступа
-- ---------------------------------------------------------------------------
-- RLS здесь НЕ включается — и это осознанно, вопреки конвенции 038_force_rls_deny_anon.sql.
-- Та миграция писалась под Supabase, где к БД ходил PostgREST от имени anon/authenticated,
-- а бэкенд — под service_role с BYPASSRLS. В Yandex PostgreSQL (Phase 10) ни одной из этих
-- ролей не существует, PostgREST нет, а владелец таблиц BYPASSRLS не имеет. Поэтому:
--   * REVOKE ... FROM anon, authenticated уронил бы всю миграцию: «role "anon" does not exist»;
--   * ENABLE + FORCE ROW LEVEL SECURITY без единой политики отрезал бы доступ и владельцу —
--     бэкенд получал бы 0 строк на SELECT и отказ на INSERT.
-- Авторизация выполняется в middleware, прямого клиентского доступа к БД нет. Остальные
-- чувствительные таблицы (employees, payslips) живут на тех же условиях.
--
-- Что имеет смысл: отозвать права у PUBLIC — эта роль существует всегда, и по умолчанию
-- на новые таблицы ей ничего не выдаётся, но явный REVOKE защищает от «GRANT ... TO PUBLIC»,
-- сделанного когда-нибудь на схеме целиком.
REVOKE ALL ON TABLE public.object_contracts        FROM PUBLIC;
REVOKE ALL ON TABLE public.object_contract_addenda FROM PUBLIC;
REVOKE ALL ON TABLE public.object_ks2_entries      FROM PUBLIC;
REVOKE ALL ON TABLE public.object_kpi_assignments  FROM PUBLIC;
REVOKE ALL ON TABLE public.object_kpi_global_roles FROM PUBLIC;
REVOKE ALL ON TABLE public.object_kpi_month_plans  FROM PUBLIC;
REVOKE ALL ON TABLE public.object_kpi_history      FROM PUBLIC;

COMMIT;
