-- 356: Зарплата — «Выплаты ФСС (1С)»: прямые выплаты СФР (бывший ФСС) по больничным, только справочно.
--
-- Зачем. Больничный по закону (255-ФЗ) платят двое: первые 3 дня — работодатель («Оплата больничных листов», в ФОТ
-- приходит из 1С строкой «Больничные» и входит в «Сумму»), с 4-го дня — СФР напрямую человеку. Вторую часть 1С
-- выгружает реестром «Прямые выплаты ФСС» (XML ЗУП, «РеестрыФСС»). Решение пользователя 10.11.2026: показывать её
-- на «Расчётах» отдельным столбцом рядом с «Больничными».
--
-- В расчётах ФОТ НЕ участвует: в «Сумму», «Остаток к выплате» и «Выплаты на карту» не входит — так считает 1С
-- (оклад сокращается на дни больничного, премия ФСС не уменьшает; сверено на сентябре 2026).
--
-- Ключевые решения:
--   * Строка — один больничный лист реестра. Реестр — по ГУИДу документа 1С; registry_hash — канонический хеш
--     содержимого реестра: тот же ГУИД с другим содержимым загрузка не перезаписывает.
--   * Месяц — «ПериодРегистрации» реестра (как в 1С): лист мог начаться в прошлом месяце.
--   * Суммы: всего (amount_gross), НДФЛ (ndfl) и на руки (amount) — как в 1С, без пересчёта: «на руки» бывает больше
--     «всего − НДФЛ» на рубль округления (НДФЛ по частям). Показывается «на руки» — как все суммы «Перечислено (1С)».
--   * Хранятся все строки, в том числе «без сотрудника». Паспорт, ИНН, СНИЛС, дата рождения не сохраняются.
--   * Удаление сотрудника строку не удаляет: employee_id → NULL.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (бэкенд читает таблицу в списке «Расчётов»). Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS payroll_fss_payments (
  id                BIGSERIAL PRIMARY KEY,
  registry_guid     UUID NOT NULL,
  registry_number   TEXT NOT NULL CHECK (btrim(registry_number) <> '' AND length(registry_number) <= 50),
  registry_date     DATE NOT NULL,
  period_month      DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  registry_hash     TEXT NOT NULL CHECK (registry_hash ~ '^[0-9a-f]{64}$'),
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  full_name_1c      TEXT NOT NULL CHECK (btrim(full_name_1c) <> '' AND length(full_name_1c) <= 300),
  person_id_all     UUID,
  -- Номер листка нетрудоспособности (ЭЛН).
  sick_leave_number TEXT CHECK (sick_leave_number IS NULL OR length(sick_leave_number) <= 50),
  reason            TEXT CHECK (reason IS NULL OR length(reason) <= 100),
  date_from         DATE,
  date_to           DATE,
  days              INTEGER CHECK (days IS NULL OR days >= 0),
  amount_gross      NUMERIC(12,2) NOT NULL CHECK (amount_gross >= 0),
  ndfl              NUMERIC(12,2) NOT NULL CHECK (ndfl >= 0),
  amount            NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  employee_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  resolution_reason TEXT NOT NULL CHECK (btrim(resolution_reason) <> '' AND length(resolution_reason) <= 300),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_fss_payments_line_unique UNIQUE (registry_guid, line_no),
  CONSTRAINT payroll_fss_payments_dates CHECK (date_from IS NULL OR date_to IS NULL OR date_from <= date_to)
);

CREATE INDEX IF NOT EXISTS payroll_fss_payments_employee_month_idx
  ON payroll_fss_payments (employee_id, period_month) WHERE employee_id IS NOT NULL;

COMMENT ON TABLE payroll_fss_payments IS
  'Прямые выплаты СФР (ФСС) по больничным из реестра 1С, справочно: в расчёт ФОТ, «Остаток» и «Выплаты на карту» не входят (356).';
COMMENT ON COLUMN payroll_fss_payments.amount IS 'На руки, как в 1С (обычно amount_gross − ndfl, бывает на рубль округления больше).';
COMMENT ON COLUMN payroll_fss_payments.period_month IS 'ПериодРегистрации реестра 1С (первое число месяца).';

COMMIT;
