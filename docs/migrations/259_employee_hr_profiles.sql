-- 259_employee_hr_profiles.sql
-- Кадровые профили («Реквизиты») — перенос раздела «Сотрудники» PassDesk в FOT.
--
-- Модель:
--   * employee_hr_profiles — 1:1 к employees, opt-in (строка есть только у тех, кого
--     оформляет отдел кадров/табельщицы). Не колонки в горячей employees: не трогаем
--     её кэши и Sigur-синк (тот же довод, что в 231).
--   * Чувствительные номера (паспорт, ИНН, КИГ, патент, р/с) — только шифротекст
--     (AES-256-GCM с версией ключа) + HMAC-хэш с pepper для поиска/дублей.
--     СНИЛС хранится в employees.pension_number (источник истины FOT), здесь — только хэш.
--   * История и OCR-конфликты хранят значения зашифрованными.
--   * Файлы — существующая documents (R2) с категориями hr_*; добавляем метаданные
--     прикладного шифрования, sha256 и soft-delete.
--   * Ключ доступа /staff-control/hr-profiles — technical-вкладка хаба «Управление
--     кадрами»; миграция НИКОМУ его не выдаёт (решение — в матрице ролей).
--
-- Зависит от 258 (hr_citizenships). ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- 1. Профиль.
CREATE TABLE IF NOT EXISTS public.employee_hr_profiles (
  employee_id integer PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  citizenship_id uuid REFERENCES public.hr_citizenships(id) ON DELETE RESTRICT,
  has_residence_permit boolean NOT NULL DEFAULT false,
  gender text CHECK (gender IN ('male', 'female')),
  birth_country_id uuid REFERENCES public.hr_citizenships(id) ON DELETE SET NULL,
  birth_region text,
  birth_city text,
  phone text,
  passport_type text CHECK (passport_type IN ('russian', 'foreign')),
  passport_number_enc text,
  passport_number_hash char(64),
  passport_key_version varchar(16),
  passport_date date,
  passport_issuer text,
  passport_department_code varchar(7),
  passport_expiry_date date,
  registration_address text,
  inn_enc text,
  inn_hash char(64),
  inn_key_version varchar(16),
  snils_hash char(64),
  kig_enc text,
  kig_hash char(64),
  kig_key_version varchar(16),
  kig_end_date date,
  patent_number_enc text,
  patent_number_hash char(64),
  patent_key_version varchar(16),
  patent_blank_number text,
  insurance_policy_number text,
  insurance_policy_date date,
  bank_account_number_enc text,
  bank_key_version varchar(16),
  bank_bik varchar(9),
  planned_exit_date date,
  notes text,
  zup_is_uploaded boolean NOT NULL DEFAULT false,
  zup_uploaded_at timestamptz,
  zup_marked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  zup_exported_at timestamptz,
  zup_exported_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  passdesk_id uuid UNIQUE,
  passdesk_id_all uuid,
  match_rule text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_hr_profiles IS
  'Кадровый профиль («Реквизиты»), opt-in 1:1 к employees. Номера документов — только шифротекст + HMAC-хэш.';
COMMENT ON COLUMN public.employee_hr_profiles.zup_is_uploaded IS
  'ДА = сотрудник занесён в 1С-ЗУП (ставится тумблером вручную; XLSX-выгрузка флаг НЕ ставит).';
COMMENT ON COLUMN public.employee_hr_profiles.zup_exported_at IS
  'Когда сотрудник последний раз попал в XLSX-выгрузку ЗУП (факт формирования файла, не загрузки в 1С).';
COMMENT ON COLUMN public.employee_hr_profiles.match_rule IS
  'Правило, по которому профиль сопоставлен при переносе из PassDesk (external_ref/snils/inn/passport_birth/manual).';

CREATE INDEX IF NOT EXISTS ehp_passport_hash_idx ON public.employee_hr_profiles(passport_number_hash) WHERE passport_number_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ehp_inn_hash_idx ON public.employee_hr_profiles(inn_hash) WHERE inn_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ehp_snils_hash_idx ON public.employee_hr_profiles(snils_hash) WHERE snils_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ehp_kig_hash_idx ON public.employee_hr_profiles(kig_hash) WHERE kig_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ehp_patent_hash_idx ON public.employee_hr_profiles(patent_number_hash) WHERE patent_number_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ehp_zup_idx ON public.employee_hr_profiles(zup_is_uploaded, zup_uploaded_at);
CREATE INDEX IF NOT EXISTS ehp_citizenship_idx ON public.employee_hr_profiles(citizenship_id);

-- 2. История изменений профиля (лента «История изменений» в «Реквизитах»).
CREATE TABLE IF NOT EXISTS public.employee_hr_profile_history (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'profile_update', 'file_upload', 'file_delete', 'ocr_run', 'ocr_apply', 'ocr_dismiss',
    'zup_toggle', 'zup_export', 'attach_existing'
  )),
  changed_fields text[],
  old_values_enc text,
  key_version varchar(16),
  document_id bigint,
  changed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  changed_by_name text,
  changed_source text NOT NULL CHECK (changed_source IN ('admin', 'ocr', 'import', 'migration', 'wizard')),
  changed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_hr_profile_history IS
  'История кадрового профиля. Прежние значения полей — зашифрованный JSON (old_values_enc).';

CREATE INDEX IF NOT EXISTS ehph_emp_idx ON public.employee_hr_profile_history(employee_id, changed_at DESC);

-- 3. Расхождения OCR ↔ карточка (ручное «Применить / Отклонить»).
CREATE TABLE IF NOT EXISTS public.employee_hr_ocr_conflicts (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  document_id bigint REFERENCES public.documents(id) ON DELETE SET NULL,
  field_name text NOT NULL,
  current_value_enc text,
  ocr_value_enc text,
  key_version varchar(16),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'dismissed')),
  resolved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, document_id, field_name)
);

CREATE INDEX IF NOT EXISTS ehoc_open_idx ON public.employee_hr_ocr_conflicts(employee_id) WHERE status = 'open';

-- 4. documents: soft-delete, прикладное шифрование файлов hr_*, результат OCR, контрольная сумма.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS recognition_result_enc text,
  ADD COLUMN IF NOT EXISTS recognition_key_version varchar(16),
  ADD COLUMN IF NOT EXISTS file_enc_algorithm varchar(32),
  ADD COLUMN IF NOT EXISTS file_enc_iv varchar(64),
  ADD COLUMN IF NOT EXISTS file_enc_tag varchar(64),
  ADD COLUMN IF NOT EXISTS file_enc_key_version varchar(16),
  ADD COLUMN IF NOT EXISTS sha256 char(64);

COMMENT ON COLUMN public.documents.deleted_at IS
  'Soft-delete (пока только hr_*): запись скрыта, объект в R2 удаляется отложенно.';
COMMENT ON COLUMN public.documents.file_enc_algorithm IS
  'Прикладное шифрование файла (hr_*): aes-256-gcm; iv/tag base64, key_version — версия HR_FIELD_ENCRYPTION_KEYS.';

CREATE INDEX IF NOT EXISTS documents_emp_cat_live_idx
  ON public.documents(employee_id, category) WHERE deleted_at IS NULL;

-- 5. Категории документов hr_* (типы PassDesk document_type_enum → коды с префиксом hr_).
ALTER TABLE public.document_categories ADD COLUMN IF NOT EXISTS "group" text NOT NULL DEFAULT 'general';

INSERT INTO public.document_categories (code, label, sort_order, "group") VALUES
  ('hr_passport',                    'Паспорт',                                            1010, 'hr'),
  ('hr_passport_translation',        'Перевод паспорта',                                   1015, 'hr'),
  ('hr_inn_document',                'ИНН',                                                1018, 'hr'),
  ('hr_bank_details',                'Реквизиты счета',                                    1020, 'hr'),
  ('hr_consent',                     'Согласие на перс.дан. Подрядчик',                    1030, 'hr'),
  ('hr_kig',                         'КИГ',                                                1040, 'hr'),
  ('hr_patent_front',                'Патент (лиц.)',                                      1050, 'hr'),
  ('hr_patent_back',                 'Патент (спин.)',                                     1060, 'hr'),
  ('hr_biometric_consent',           'Согласие на перс.дан. Генподряд',                    1070, 'hr'),
  ('hr_biometric_consent_developer', 'Согласие на перс.дан. Застройщик',                   1080, 'hr'),
  ('hr_diploma',                     'Диплом',                                             1090, 'hr'),
  ('hr_snils_card',                  'СНИЛС',                                              1095, 'hr'),
  ('hr_med_book',                    'Мед.книжка',                                         1100, 'hr'),
  ('hr_visa',                        'Виза',                                               1105, 'hr'),
  ('hr_migration_card',              'Миграционная карта',                                 1110, 'hr'),
  ('hr_arrival_notice',              'Уведомление о прибытии',                             1120, 'hr'),
  ('hr_patent_payment_receipt',      'Чек оплаты патента',                                 1130, 'hr'),
  ('hr_insurance_policy',            'Страховой полис',                                    1135, 'hr'),
  ('hr_mvd_notification',            'Уведомление МВД',                                    1140, 'hr'),
  ('hr_memo_approval',               'Служебная записка (согласование)',                   1150, 'hr'),
  ('hr_employment_history_stdr',     'Справка о трудовой деятельности работника (СТДР)',   1160, 'hr'),
  ('hr_registration_amina',          'Регистрация (Амина)',                                1170, 'hr'),
  ('hr_military_id',                 'Военный билет',                                      1180, 'hr'),
  ('hr_application_scan',            'Скан заявления',                                     1185, 'hr'),
  ('hr_other',                       'Иные документы',                                     1190, 'hr')
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  "group" = EXCLUDED."group";

-- 6. Ключ доступа к реквизитам (кнопка «Реквизиты» в карточке/ростере, мастер
--    «Добавить сотрудника» со сканами, выгрузка ЗУП). technical: отдельным пунктом
--    меню не показывается, участвует в матрице ролей. Никому не выдаётся.
INSERT INTO public.access_pages (key, label, group_code, group_label, area, surface, supports_edit, sort_order, is_active)
VALUES
  ('/staff-control/hr-profiles', 'Управление кадрами — Реквизиты (кадровые данные)',
   'work', 'Управление', 'admin', 'technical', true, 107, true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  area = EXCLUDED.area,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

NOTIFY pgrst, 'reload schema';

COMMIT;
