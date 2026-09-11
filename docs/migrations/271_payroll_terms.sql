-- 271: Раздел «Зарплата», этап 1 — условия оплаты, каталог видов начислений, настройки.
--
-- Зачем. Зарплатных данных в системе нет: миграция 176 обнулила employees.current_salary /
-- salary_actual / salary_calculated / staff_units и вычистила salary_history. Считать не из
-- чего. Эти таблицы — единственный источник условий оплаты для будущего расчёта.
--
-- Ключевые решения:
--   * Историчность вместо перезаписи. Перевод «по графику» → «по часам» = закрыть текущую
--     строку (effective_to = D-1) и вставить новую. Прошлые расчёты ссылаются на terms_id
--     и не переигрываются. EXCLUDE физически не даёт создать пересечение периодов.
--   * Категория персонала живёт здесь, а не в employees: она историчная и меняется вместе
--     с условиями оплаты. Из positions.category её не вывести — там 304 позиции 'other'
--     и одна 'worker'.
--   * Неполная занятость выражается ОДНИМ механизмом — личным графиком. На проде так и есть:
--     «0,5 ставки- Полянский» — 4 ч/день, «5+0 (Студенты)» — 5 ч, «Студент (Бузаров)» — 3 ч.
--     Поэтому staff_units в расчёте НЕ участвует (иначе половина применилась бы дважды),
--     а monthly_salary — оклад по условиям конкретного сотрудника.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- EXCLUDE с daterange требует btree_gist для оператора = по scalar-колонкам.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 1. Условия оплаты ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_compensation_terms (
  id             BIGSERIAL PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- Корень компании-работодателя (org_departments 2-го уровня). NULL = единственное
  -- юрлицо. Заложено сразу: добавлять юрлицо задним числом в условия, расчёты,
  -- обязательства и выплаты заметно дороже, чем держать пустую колонку.
  organization_id UUID NULL REFERENCES org_departments(id),
  staff_category TEXT NOT NULL CHECK (staff_category IN ('office','itr','worker')),
  calc_type      TEXT NOT NULL CHECK (calc_type IN ('salary','hourly')),
  monthly_salary NUMERIC(12,2),
  hourly_rate    NUMERIC(12,4),
  -- Штатная единица: справочно, для штатного расписания и отчётов. В расчёте НЕ участвует.
  staff_units    NUMERIC(5,3) NOT NULL DEFAULT 1.000
                 CHECK (staff_units > 0 AND staff_units <= 2),
  time_accounting_mode TEXT NOT NULL DEFAULT 'daily'
                 CHECK (time_accounting_mode IN ('daily','summarized')),
  accounting_period_months INT CHECK (accounting_period_months BETWEEN 1 AND 12),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  change_reason  TEXT,
  order_number   TEXT,
  order_date     DATE,
  note           TEXT,
  created_by     UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payroll_terms_amount_xor CHECK (
       (calc_type = 'salary' AND monthly_salary > 0 AND hourly_rate IS NULL)
    OR (calc_type = 'hourly' AND hourly_rate  > 0 AND monthly_salary IS NULL)),
  CONSTRAINT payroll_terms_summarized CHECK (
    time_accounting_mode = 'daily' OR accounting_period_months IS NOT NULL),
  CONSTRAINT payroll_terms_range CHECK (
    effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT payroll_terms_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&)
);

CREATE INDEX IF NOT EXISTS idx_payroll_terms_employee_from
  ON payroll_compensation_terms (employee_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_terms_active
  ON payroll_compensation_terms (staff_category, calc_type)
  WHERE effective_to IS NULL;

COMMENT ON TABLE payroll_compensation_terms IS
  'Условия оплаты сотрудника периодами «действует с — по». Единственный источник вида '
  'оплаты и суммы для расчёта зарплаты. employees.current_salary и salary_history — legacy, '
  'не используются.';
COMMENT ON COLUMN payroll_compensation_terms.monthly_salary IS
  'Оклад по условиям ЭТОГО сотрудника. В расчёте НЕ умножается на staff_units: неполная '
  'занятость выражается личным графиком (work_schedules.work_hours).';
COMMENT ON COLUMN payroll_compensation_terms.staff_units IS
  'Штатная единица — справочно. В арифметике расчёта не участвует. staff_units <> 1 при '
  'полной норме графика — признак, что занятость задана дважды или не задана вовсе.';
COMMENT ON COLUMN payroll_compensation_terms.staff_category IS
  'office — Офис, itr — Стройка: ИТР, worker — Рабочие. Задаёт значение calc_type '
  'по умолчанию и служит для отбора; на формулу расчёта не влияет.';
COMMENT ON COLUMN payroll_compensation_terms.organization_id IS
  'Корень компании-работодателя. NULL = единственное юрлицо.';

-- ── 2. Каталог видов начислений и удержаний ─────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_item_types (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  -- reimbursement (возмещение покупки) не заработок; informational — сумма к сведению,
  -- не создающая обязательства работодателя.
  kind            TEXT NOT NULL
                  CHECK (kind IN ('earning','deduction','reimbursement','informational')),
  payer           TEXT NOT NULL DEFAULT 'employer' CHECK (payer IN ('employer','sfr')),
  -- Часть зарплаты. DEFAULT нет намеренно: для удержаний и возмещений «базовая часть»
  -- была бы неверной по умолчанию.
  pay_component   TEXT NOT NULL
                  CHECK (pay_component IN ('base','bonus','compensation','other')),
  calc_method     TEXT NOT NULL CHECK (calc_method IN ('auto','manual','imported')),
  -- DEFAULT false: включать явно и только для видов, подтверждённых бухгалтерией.
  affects_average BOOLEAN NOT NULL DEFAULT false,
  zup_code        TEXT,
  sort_order      INT NOT NULL DEFAULT 100,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT payroll_item_types_component CHECK (
    kind = 'earning' OR pay_component = 'other')
);

COMMENT ON TABLE payroll_item_types IS
  'Каталог видов начислений и удержаний. Сумма без вида начисления запрещена. '
  'Использованный вид не удаляется — только is_active = false, иначе расшифровка '
  'прошлого расчёта потеряет название строки.';
COMMENT ON COLUMN payroll_item_types.payer IS
  'Обязательство работодателя формируют только строки payer = employer. Пособие за счёт '
  'СФР в фонд оплаты труда не входит.';

INSERT INTO payroll_item_types
  (code, name, kind, payer, pay_component, calc_method, affects_average, sort_order) VALUES
  ('salary_base',          'Оплата по окладу',              'earning',       'employer', 'base',         'auto',     true,  10),
  ('hourly_base',          'Оплата по часам',               'earning',       'employer', 'base',         'auto',     true,  20),
  ('overtime',             'Доплата за переработку',        'earning',       'employer', 'compensation', 'manual',   true,  30),
  ('night',                'Доплата за ночные часы',        'earning',       'employer', 'compensation', 'manual',   true,  40),
  ('weekend_work',         'Доплата за работу в выходной',  'earning',       'employer', 'compensation', 'manual',   true,  50),
  ('bonus',                'Премия',                        'earning',       'employer', 'bonus',        'manual',   true,  60),
  ('vacation_pay',         'Отпускные',                     'earning',       'employer', 'other',        'manual',   false, 70),
  ('sick_pay_employer',    'Больничный за счёт работодателя','earning',      'employer', 'other',        'manual',   false, 80),
  ('sick_pay_sfr',         'Пособие за счёт СФР',           'informational', 'sfr',      'other',        'imported', false, 90),
  ('expense_reimbursement','Возмещение расходов',           'reimbursement', 'employer', 'other',        'manual',   false, 100),
  ('workwear_deduction',   'Удержание за спецодежду',       'deduction',     'employer', 'other',        'manual',   false, 110),
  ('premium_reduction',    'Снижение премии',               'deduction',     'employer', 'other',        'manual',   false, 120),
  ('damage_compensation',  'Возмещение ущерба',             'deduction',     'employer', 'other',        'manual',   false, 130),
  ('statutory_deduction',  'Удержание по ст. 137 ТК',       'deduction',     'employer', 'other',        'manual',   false, 140),
  ('other_earning',        'Прочее начисление',             'earning',       'employer', 'other',        'manual',   false, 150),
  ('other_deduction',      'Прочее удержание',              'deduction',     'employer', 'other',        'manual',   false, 160)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  kind = EXCLUDED.kind,
  payer = EXCLUDED.payer,
  pay_component = EXCLUDED.pay_component,
  calc_method = EXCLUDED.calc_method,
  affects_average = EXCLUDED.affects_average,
  sort_order = EXCLUDED.sort_order;

-- ── 3. Настройки расчёта ────────────────────────────────────────────────────
--
-- Историчные: сохраняются «с даты», прошлые периоды не пересчитываются.
-- rule_version сюда НЕ входит — это версия кода расчёта, а не бухгалтерский параметр.
CREATE TABLE IF NOT EXISTS payroll_settings (
  id              BIGSERIAL PRIMARY KEY,
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  advance_mode    TEXT NOT NULL
                  CHECK (advance_mode IN ('actual_hours','percent_of_base')),
  advance_percent NUMERIC(5,2)
                  CHECK (advance_percent > 0 AND advance_percent <= 100),
  period_mode     TEXT NOT NULL DEFAULT 'halves'
                  CHECK (period_mode IN ('halves','month')),
  -- Пока '1c', БД запрещает создавать платёжное обязательство из расчёта портала
  -- (проверка появится вместе с payroll_settlement_entries отдельной миграцией этапа 3;
  -- номер 273 уже занят 273_person_blacklist.sql).
  source_of_truth TEXT NOT NULL DEFAULT '1c' CHECK (source_of_truth IN ('1c','portal')),
  created_by      UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_settings_range CHECK (
    effective_to IS NULL OR effective_to >= effective_from),
  -- Строгий XOR: процент нужен ровно тогда, когда выбран режим процента.
  CONSTRAINT payroll_settings_advance_xor CHECK (
       (advance_mode = 'actual_hours'    AND advance_percent IS NULL)
    OR (advance_mode = 'percent_of_base' AND advance_percent IS NOT NULL)),
  CONSTRAINT payroll_settings_no_overlap EXCLUDE USING gist (
    daterange(effective_from, effective_to, '[]') WITH &&)
);

COMMENT ON TABLE payroll_settings IS
  'Историчные настройки расчёта зарплаты. Действуют «с даты»: изменение не пересчитывает '
  'закрытые периоды.';
COMMENT ON COLUMN payroll_settings.source_of_truth IS
  'Кто источник окончательной суммы. 1c — расчёт портала прогнозный, обязательство '
  'создаётся только из подтверждённого итога 1С. Переключение на portal — отдельное '
  'решение с будущей датой, под аудитом и critical-2FA.';

-- Стартовая строка: аванс по фактически отработанному времени, половины месяца,
-- источник истины — 1С. Дата — 2000-01-01, чтобы настройка действовала для любого
-- периода, который решат посчитать задним числом.
INSERT INTO payroll_settings (effective_from, advance_mode, period_mode, source_of_truth)
SELECT DATE '2000-01-01', 'actual_hours', 'halves', '1c'
 WHERE NOT EXISTS (SELECT 1 FROM payroll_settings);

COMMIT;
