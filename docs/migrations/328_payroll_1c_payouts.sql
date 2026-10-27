-- 328: Зарплата — «Перечислено (1С)»: ведомости выплаты из 1С (XML ЗУП2 и внешней базы), только справочно.
--
-- Зачем. 1С выгружает «Ведомость в банк» — кому и сколько перечислено на карту за месяц начисления. В ФОТ таким
-- суммам места не было: «Оплачено» (295) — начисления и удержания, «Выплачено» удалено 298, payments пуста.
-- Решение пользователя 27.10.2026: загрузка кнопкой с предпросмотром, показ в «Истории выплат» карточки.
--
-- В расчётах ФОТ НЕ участвует: таблицы читают только загрузка и «История выплат». Зарплата, отпуска и больничные
-- по-прежнему считаются по табелю; «К выплате» = начислено − удержано («Оплачено»).
--
-- Ключевые решения:
--   * Документ — по ГУИДу 1С (оба формата одной ведомости дают один ГУИД). content_hash — канонический хеш
--     содержимого (ГУИД, номер ЗУП3, дата, месяц, способ, итог, ключи строк), не файла: два формата одной ведомости
--     дают один хеш. revision растёт при каждой мутации (new / replace / enrich / relink), no-op её не меняет.
--   * Хранятся ВСЕ строки ведомости, в том числе «без сотрудника» (unmatched): ничего не теряется.
--   * Сотрудник строки — только по коду физлица 1С (id_all) или подтверждением оператора; ФИО — не ключ.
--   * Паспорт, ИНН, СНИЛС, дата рождения из файла не сохраняются — колонок под них нет.
--   * Журнал мутаций хранит прежнюю шапку и строки (только поля этих таблиц), чтобы состояние можно было восстановить.
--   * Удаление сотрудника строку не удаляет: employee_id → NULL (у подтверждённой строки — только так).
--
-- Индекс по employee_hr_profiles.passdesk_id_all — не уникальный: id_all — физлицо, у одного человека бывает
-- несколько карточек (уволен из СУ-10, принят через подрядчика). Код сопоставления разбирает 0 / 1 / много.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE INDEX IF NOT EXISTS employee_hr_profiles_passdesk_id_all_idx
  ON employee_hr_profiles (passdesk_id_all) WHERE passdesk_id_all IS NOT NULL;

CREATE TABLE IF NOT EXISTS payroll_1c_payout_documents (
  id               BIGSERIAL PRIMARY KEY,
  doc_guid         UUID NOT NULL UNIQUE,
  -- Номер ведомости в ЗУП3 («0000-002644»): «Док_Номер» ЗУП2 и «НомерБазаИсточник» внешнего формата.
  doc_number       TEXT NOT NULL CHECK (btrim(doc_number) <> '' AND length(doc_number) <= 50),
  -- Номер документа ЗУП2 («00003123»): заполняется из <номер> внешнего формата; у ЗУП2-файла его нет.
  zup2_number      TEXT CHECK (zup2_number IS NULL OR (btrim(zup2_number) <> '' AND length(zup2_number) <= 50)),
  doc_date         DATE NOT NULL,
  period_month     DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  payment_method   TEXT NOT NULL CHECK (btrim(payment_method) <> '' AND length(payment_method) <= 100),
  salary_project   TEXT CHECK (salary_project IS NULL OR (btrim(salary_project) <> '' AND length(salary_project) <= 200)),
  organization_inn TEXT NOT NULL CHECK (organization_inn = '7736255508'),
  total_amount     NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  content_hash     TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  revision         INTEGER NOT NULL CHECK (revision > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Автор в колонке с NULL: ON DELETE SET NULL без DEFAULT (политика миграции 285).
  updated_by       UUID REFERENCES user_profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payroll_1c_payout_lines (
  document_id       BIGINT NOT NULL REFERENCES payroll_1c_payout_documents(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  -- Ключ строки, общий для обоих форматов: нормализованное ФИО + сумма в копейках + номер среди одинаковых.
  line_key          TEXT NOT NULL CHECK (btrim(line_key) <> ''),
  full_name_1c      TEXT NOT NULL CHECK (btrim(full_name_1c) <> '' AND length(full_name_1c) <= 300),
  person_id_all     UUID,
  brigade_1c        TEXT CHECK (brigade_1c IS NULL OR length(brigade_1c) <= 300),
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  employee_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  resolution        TEXT NOT NULL CHECK (resolution IN ('auto_id_all', 'confirmed', 'unmatched')),
  resolution_reason TEXT CHECK (resolution_reason IS NULL OR length(resolution_reason) <= 300),
  PRIMARY KEY (document_id, line_no),
  CONSTRAINT payroll_1c_payout_lines_key_unique UNIQUE (document_id, line_key),
  -- «Без сотрудника» — всегда без employee_id; у сопоставленной employee_id пуст только после удаления сотрудника.
  CONSTRAINT payroll_1c_payout_lines_unmatched_no_employee CHECK (resolution <> 'unmatched' OR employee_id IS NULL)
);

CREATE INDEX IF NOT EXISTS payroll_1c_payout_lines_employee_idx
  ON payroll_1c_payout_lines (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payroll_1c_payout_lines_person_idx
  ON payroll_1c_payout_lines (person_id_all) WHERE person_id_all IS NOT NULL;

CREATE TABLE IF NOT EXISTS payroll_1c_payout_imports (
  id                  BIGSERIAL PRIMARY KEY,
  document_id         BIGINT NOT NULL REFERENCES payroll_1c_payout_documents(id) ON DELETE CASCADE,
  action              TEXT NOT NULL CHECK (action IN ('new', 'replace', 'enrich', 'relink')),
  revision_before     INTEGER NOT NULL CHECK (revision_before >= 0),
  revision_after      INTEGER NOT NULL CHECK (revision_after = revision_before + 1),
  content_hash_before TEXT CHECK (content_hash_before IS NULL OR content_hash_before ~ '^[0-9a-f]{64}$'),
  content_hash_after  TEXT NOT NULL CHECK (content_hash_after ~ '^[0-9a-f]{64}$'),
  -- Прежние шапка (replace, enrich) и строки (replace, relink) — только поля таблиц выше, без XML и ПДн.
  previous_header     JSONB,
  previous_lines      JSONB,
  source_format       TEXT NOT NULL CHECK (source_format IN ('zup2', 'external')),
  file_name           TEXT CHECK (file_name IS NULL OR (btrim(file_name) <> '' AND length(file_name) <= 200)),
  file_sha256         TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  lines_matched       INTEGER NOT NULL CHECK (lines_matched >= 0),
  lines_unmatched     INTEGER NOT NULL CHECK (lines_unmatched >= 0),
  amount_matched      NUMERIC(12,2) NOT NULL CHECK (amount_matched >= 0),
  amount_unmatched    NUMERIC(12,2) NOT NULL CHECK (amount_unmatched >= 0),
  -- Автор в колонке с NULL: ON DELETE SET NULL без DEFAULT (политика миграции 285).
  imported_by         UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_1c_payout_imports_new_from_zero CHECK ((action = 'new') = (revision_before = 0)),
  CONSTRAINT payroll_1c_payout_imports_replace_snapshot CHECK (
    action <> 'replace' OR (previous_header IS NOT NULL AND previous_lines IS NOT NULL)),
  CONSTRAINT payroll_1c_payout_imports_relink_snapshot CHECK (action <> 'relink' OR previous_lines IS NOT NULL),
  CONSTRAINT payroll_1c_payout_imports_enrich_snapshot CHECK (action <> 'enrich' OR previous_header IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS payroll_1c_payout_imports_document_idx
  ON payroll_1c_payout_imports (document_id, revision_after);

COMMENT ON TABLE payroll_1c_payout_documents IS
  'Ведомости выплаты из 1С (ЗУП2 / внешняя база): кому сколько перечислено за месяц начисления. Справочно, из 1С; '
  'в расчётах ФОТ не участвует. Текущее состояние документа; история — payroll_1c_payout_imports.';
COMMENT ON COLUMN payroll_1c_payout_documents.period_month IS
  'Месяц начисления (ПериодРегистрации) — первое число; не дата перечисления (doc_date).';
COMMENT ON COLUMN payroll_1c_payout_documents.content_hash IS
  'sha256 канонического содержимого: ГУИД, номер ЗУП3, дата, месяц, способ, итог, ключи строк. Поля формата '
  '(номер ЗУП2, организация, бригада, зарплатный проект, id_all) не входят.';
COMMENT ON TABLE payroll_1c_payout_lines IS
  'Все строки ведомости выплаты из 1С, в том числе «без сотрудника». Справочно, из 1С; в расчётах ФОТ не участвует. '
  'Паспорт, ИНН, СНИЛС не хранятся.';
COMMENT ON COLUMN payroll_1c_payout_lines.resolution IS
  'auto_id_all — по коду физлица 1С; confirmed — подтвердил оператор; unmatched — без сотрудника.';
COMMENT ON TABLE payroll_1c_payout_imports IS
  'Журнал мутаций ведомостей выплаты из 1С (без изменений — не пишется): прежние шапка и строки для восстановления.';

REVOKE ALL ON TABLE public.payroll_1c_payout_documents FROM PUBLIC;
REVOKE ALL ON TABLE public.payroll_1c_payout_lines FROM PUBLIC;
REVOKE ALL ON TABLE public.payroll_1c_payout_imports FROM PUBLIC;

COMMIT;
