-- 372: увольнение из 1С ЗУП3 по API (POST /api/public/v1/payroll/dismissals): приказ, компенсация отпуска, выходное
-- пособие.
--
-- * «Оплачено»: новая статья vacation_compensation «Компенсация отпуска при увольнении» (отдельно от «Оплаты отпуска»:
--   строка vacation заменяет в расчёте ведомость отпускных). Ячейки vacation_compensation / severance, которые ведёт
--   документ увольнения из 1С, помечаются source_kind = 'api_1c_dismissal'; source_before — значение до 1С (для отмены).
--   Такую ячейку меняет только API (SET LOCAL fot.paid_writer = 'api_1c_dismissal'): скрипт загрузки файла получит
--   ошибку и пропустит её. DELETE не запрещён (каскад удаления сотрудника).
-- * data_api_keys.allow_payroll_dismissal_import — право ключа на приём увольнений.
-- * payroll_1c_dismissal_documents — текущее состояние документов 1С (надгробие распроведённого — без бизнес-полей);
--   payroll_1c_dismissal_revisions — журнал изменений только на добавление.
-- Повтор миграции безопасен.

BEGIN;

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_item_code;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
  'contract', 'bonus', 'sick_leave', 'vacation',
  'housing', 'travel', 'overtime', 'recalc_prev', 'severance', 'supplement', 'planned_supplement', 'loan',
  'kpi', 'premium', 'premium_contract', 'gph', 'extra_work', 'substitution', 'car_compensation', 'deposit',
  'day_rate', 'workwear_accrual', 'advance_accrual', 'fine_refund',
  'reserve', 'material_aid', 'imprest_overspend', 'salary_extra', 'vacation_compensation',
  'meals', 'workwear', 'safety_fine', 'fines', 'writ_deduction',
  'vacation_deduction', 'loan_repayment', 'loan_interest', 'apartment', 'imprest', 'third_party',
  'transport', 'mobile', 'bank_fees',
  'alimony', 'tmc', 'car_rent', 'property_damage', 'prior_debts'));

ALTER TABLE payroll_paid_amounts ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE payroll_paid_amounts ADD COLUMN IF NOT EXISTS source_before JSONB;
ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_source_kind;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_source_kind CHECK (
  source_kind IS NULL OR (source_kind = 'api_1c_dismissal' AND item_code IN ('vacation_compensation', 'severance')));

COMMENT ON TABLE payroll_paid_amounts IS
  '«Оплачено» — суммы статей «Сводной ведомости» ЗУП по месяцам (карточка «Зарплата → Подробно»). Пустая ячейка — '
  'строки нет. Отпускные и больничные (vacation, sick_leave) и строки увольнения из 1С (vacation_compensation, '
  'severance с source_kind = api_1c_dismissal) входят в расчёт ФОТ; остальные статьи — справочно.';
COMMENT ON COLUMN payroll_paid_amounts.source_kind IS
  'api_1c_dismissal — ячейку ведёт документ увольнения из 1С (payroll_1c_dismissal_documents); NULL — файл или ввод.';
COMMENT ON COLUMN payroll_paid_amounts.source_before IS
  'Значение до того, как ячейку взял документ 1С: {"amount","updated_by","updated_at"} или {"absent": true}.';

CREATE OR REPLACE FUNCTION payroll_paid_amounts_guard_api_cells() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_kind = 'api_1c_dismissal'
     AND current_setting('fot.paid_writer', true) IS DISTINCT FROM 'api_1c_dismissal' THEN
    RAISE EXCEPTION 'Ячейка «Оплачено» (сотрудник %, %, %) ведётся документом увольнения из 1С — меняет только API',
      OLD.employee_id, OLD.month, OLD.item_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_paid_amounts_guard_api_cells ON payroll_paid_amounts;
CREATE TRIGGER payroll_paid_amounts_guard_api_cells
  BEFORE UPDATE ON payroll_paid_amounts
  FOR EACH ROW EXECUTE FUNCTION payroll_paid_amounts_guard_api_cells();

ALTER TABLE data_api_keys ADD COLUMN IF NOT EXISTS allow_payroll_dismissal_import BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN data_api_keys.allow_payroll_dismissal_import IS
  'Право ключа на приём увольнений из 1С (POST /api/public/v1/payroll/dismissals): приказ, компенсация, пособие.';

CREATE TABLE IF NOT EXISTS payroll_1c_dismissal_documents (
  id                         BIGSERIAL PRIMARY KEY,
  doc_guid                   UUID NOT NULL UNIQUE,
  source_revision            BIGINT NOT NULL CHECK (source_revision > 0),
  posted                     BOOLEAN NOT NULL,
  supersedes_guid            UUID,
  doc_number                 TEXT CHECK (doc_number IS NULL OR (btrim(doc_number) <> '' AND length(doc_number) <= 50)),
  doc_date                   DATE,
  period_month               DATE CHECK (period_month IS NULL OR period_month = date_trunc('month', period_month)::date),
  organization_inn           TEXT CHECK (organization_inn IS NULL OR organization_inn IN ('7736255508', '7705794997')),
  employee_id                INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  person_id_all              UUID,
  full_name_1c               TEXT CHECK (full_name_1c IS NULL OR length(full_name_1c) <= 300),
  dismissal_date             DATE,
  basis                      TEXT CHECK (basis IS NULL OR length(basis) <= 200),
  vacation_compensation      NUMERIC(12,2) CHECK (vacation_compensation IS NULL OR vacation_compensation >= 0),
  vacation_compensation_days NUMERIC(6,2) CHECK (vacation_compensation_days IS NULL OR vacation_compensation_days >= 0),
  severance                  NUMERIC(12,2) CHECK (severance IS NULL OR severance >= 0),
  content_hash               TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  -- Действующий: проведён и не заменён проведённым исправлением (пересчитывает сервис при каждом приёме).
  is_active                  BOOLEAN NOT NULL DEFAULT false,
  warnings                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_api_key_id            UUID REFERENCES data_api_keys(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_1c_dismissal_posted_fields CHECK (NOT posted OR (
    doc_number IS NOT NULL AND doc_date IS NOT NULL AND period_month IS NOT NULL AND organization_inn IS NOT NULL
    AND person_id_all IS NOT NULL AND dismissal_date IS NOT NULL
    AND vacation_compensation IS NOT NULL AND severance IS NOT NULL)),
  CONSTRAINT payroll_1c_dismissal_not_self CHECK (supersedes_guid IS NULL OR supersedes_guid <> doc_guid)
);
CREATE INDEX IF NOT EXISTS payroll_1c_dismissal_documents_pair_idx
  ON payroll_1c_dismissal_documents (employee_id, period_month);
CREATE INDEX IF NOT EXISTS payroll_1c_dismissal_documents_active_idx
  ON payroll_1c_dismissal_documents (period_month, employee_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS payroll_1c_dismissal_documents_supersedes_idx
  ON payroll_1c_dismissal_documents (supersedes_guid);

CREATE TABLE IF NOT EXISTS payroll_1c_dismissal_revisions (
  id                BIGSERIAL PRIMARY KEY,
  document_id       BIGINT NOT NULL REFERENCES payroll_1c_dismissal_documents(id) ON DELETE CASCADE,
  source_revision   BIGINT NOT NULL CHECK (source_revision > 0),
  action            TEXT NOT NULL CHECK (action IN ('new', 'updated', 'unposted')),
  previous_document JSONB,
  cell_changes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_api_key_id   UUID REFERENCES data_api_keys(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, source_revision)
);

COMMENT ON TABLE payroll_1c_dismissal_documents IS
  'Увольнения из 1С ЗУП3 (API): приказ и начисления компенсации отпуска и выходного пособия. Текущее состояние документа.';
COMMENT ON TABLE payroll_1c_dismissal_revisions IS
  'Журнал изменений документов увольнения из 1С: прежнее состояние документа и изменения ячеек «Оплачено».';

COMMIT;
