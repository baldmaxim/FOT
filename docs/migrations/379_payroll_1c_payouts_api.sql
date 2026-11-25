-- 379: ведомости выплаты из 1С по API (POST /api/public/v1/payroll/payouts, отмена — /payroll/payouts/cancel).
--
-- 1С сама отправляет проведённую ведомость (тот же XML «зп_документы_31», что «Выгрузить данные») с версией документа
-- (растёт при каждом изменении в очереди 1С); распроведение и удаление — отмена по ГУИДу и версии.
--  - origin — откуда ведомость: api | file | register | generator | brigade_sheet | to_pay. Старые заполняются по
--    source: ведомость бригады — brigade_sheet, «ЗП к выплате» ЗУП2 (строки с причиной «ЗП к выплате …») — to_pay,
--    остальные — file (журнала у них нет — грузились скриптами). Ведомость из API меняет только API (триггер ниже:
--    кнопка, скрипты, ручной SQL получают ошибку; API и откат ставят SET LOCAL fot.payout_writer = 'api'). Ведомость
--    file / register / generator, пришедшая из 1С по API (тот же ГУИД или номер и дата), переходит под API — adopt
--    (решение пользователя 25.11): строки — из 1С, решения ФОТ (перенос месяца, сотрудник вручную) переносятся.
--  - «ЗП к выплате» (to_pay): пришла по API «Зарплата за месяц» или «Премии» сотрудника за месяц — его строка
--    снимается (payroll_1c_payout_to_pay_superseded — снимок), не осталось таких ведомостей API — возвращается.
--  - comment — «Комментарий» документа 1С; basis — «Основание» строки; id_fot_1c — ID_FOT, который прислала 1С
--    (отдельно от итогового employee_id: сотрудника могут удалить, факт присланного остаётся).
--  - payroll_1c_payout_api_states — состояние API по ГУИДу: версия, действует / отменена, хеш, документ. Отмена
--    неизвестного ГУИДа — надгробие без документа: поздняя старая версия ведомость не оживит.
--  - Отмена документ не удаляет: строки (суммы) удаляются, шапка и журнал остаются; повторное проведение
--    (версия больше) создаёт строки заново — действие restore.
--  - payroll_1c_payout_api_batches — выгрузки API со снимками «до» для отката (scripts/rollback-payouts-api-batch.ts).
-- Повтор безопасен. Откат — docs/rollbacks/379_payroll_1c_payouts_api_rollback.sql.

BEGIN;

-- Документы: откуда, комментарий 1С.
ALTER TABLE payroll_1c_payout_documents ADD COLUMN IF NOT EXISTS origin TEXT;
UPDATE payroll_1c_payout_documents SET origin = CASE WHEN source = 'brigade_sheet' THEN 'brigade_sheet' ELSE 'file' END
 WHERE origin IS NULL;
-- «ЗП к выплате» ЗУП2 (генератор 18.11, строки с причиной «ЗП к выплате …»).
UPDATE payroll_1c_payout_documents d SET origin = 'to_pay'
 WHERE d.origin = 'file'
   AND EXISTS (SELECT 1 FROM payroll_1c_payout_lines l WHERE l.document_id = d.id AND l.resolution_reason LIKE 'ЗП к выплате %');
ALTER TABLE payroll_1c_payout_documents ALTER COLUMN origin SET DEFAULT 'file';
ALTER TABLE payroll_1c_payout_documents ALTER COLUMN origin SET NOT NULL;
ALTER TABLE payroll_1c_payout_documents DROP CONSTRAINT IF EXISTS payroll_1c_payout_documents_origin_check;
ALTER TABLE payroll_1c_payout_documents ADD CONSTRAINT payroll_1c_payout_documents_origin_check
  CHECK (origin IN ('api', 'file', 'register', 'generator', 'brigade_sheet', 'to_pay'));
ALTER TABLE payroll_1c_payout_documents ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE payroll_1c_payout_documents DROP CONSTRAINT IF EXISTS payroll_1c_payout_documents_comment_check;
ALTER TABLE payroll_1c_payout_documents ADD CONSTRAINT payroll_1c_payout_documents_comment_check
  CHECK (comment IS NULL OR (btrim(comment) <> '' AND length(comment) <= 1000));
-- Номер и дата — уникальны внутри организации (на 25.11.2026 дублей 0): та же ведомость под другим ГУИДом не грузится.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_1c_payout_documents_org_number_date_uniq
  ON payroll_1c_payout_documents (organization_inn, doc_number, doc_date);

-- Строки: основание, присланный ID_FOT, сопоставление по ID_FOT.
ALTER TABLE payroll_1c_payout_lines ADD COLUMN IF NOT EXISTS basis TEXT;
ALTER TABLE payroll_1c_payout_lines DROP CONSTRAINT IF EXISTS payroll_1c_payout_lines_basis_check;
ALTER TABLE payroll_1c_payout_lines ADD CONSTRAINT payroll_1c_payout_lines_basis_check
  CHECK (basis IS NULL OR (btrim(basis) <> '' AND length(basis) <= 500));
ALTER TABLE payroll_1c_payout_lines ADD COLUMN IF NOT EXISTS id_fot_1c INTEGER;
ALTER TABLE payroll_1c_payout_lines DROP CONSTRAINT IF EXISTS payroll_1c_payout_lines_id_fot_1c_check;
ALTER TABLE payroll_1c_payout_lines ADD CONSTRAINT payroll_1c_payout_lines_id_fot_1c_check
  CHECK (id_fot_1c IS NULL OR id_fot_1c > 0);
ALTER TABLE payroll_1c_payout_lines DROP CONSTRAINT IF EXISTS payroll_1c_payout_lines_resolution_check;
ALTER TABLE payroll_1c_payout_lines ADD CONSTRAINT payroll_1c_payout_lines_resolution_check
  CHECK (resolution IN ('auto_id_fot', 'auto_id_all', 'confirmed', 'unmatched'));

-- Право ключа data-api.
ALTER TABLE data_api_keys ADD COLUMN IF NOT EXISTS allow_payroll_payouts_import BOOLEAN NOT NULL DEFAULT false;

-- Выгрузки API: что изменила каждая (снимки «до» по ведомостям) — для отката.
CREATE TABLE IF NOT EXISTS payroll_1c_payout_api_batches (
  batch_id          UUID PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('payouts', 'cancel')),
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  data_api_key_id   UUID REFERENCES data_api_keys(id) ON DELETE SET NULL,
  body_sha256       TEXT NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  changes           JSONB NOT NULL,
  rolled_back_at    TIMESTAMPTZ,
  rolled_back_by    TEXT CHECK (rolled_back_by IS NULL OR (btrim(rolled_back_by) <> '' AND length(rolled_back_by) <= 200)),
  CONSTRAINT payroll_1c_payout_api_batches_rollback CHECK ((rolled_back_at IS NULL) = (rolled_back_by IS NULL))
);

-- Состояние API по ГУИДу ведомости.
CREATE TABLE IF NOT EXISTS payroll_1c_payout_api_states (
  doc_guid        UUID PRIMARY KEY,
  version         BIGINT NOT NULL CHECK (version > 0),
  state           TEXT NOT NULL CHECK (state IN ('active', 'cancelled')),
  api_hash        TEXT CHECK (api_hash IS NULL OR api_hash ~ '^[0-9a-f]{64}$'),
  document_id     BIGINT REFERENCES payroll_1c_payout_documents(id) ON DELETE SET NULL,
  data_api_key_id UUID REFERENCES data_api_keys(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_1c_payout_api_states_active_hash CHECK (state <> 'active' OR api_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS payroll_1c_payout_api_states_document_idx
  ON payroll_1c_payout_api_states (document_id) WHERE document_id IS NOT NULL;

-- Журнал загрузок: действия API (отмена, возврат после отмены, откат выгрузки), источник api, ключ и выгрузка.
ALTER TABLE payroll_1c_payout_imports DROP CONSTRAINT IF EXISTS payroll_1c_payout_imports_action_check;
ALTER TABLE payroll_1c_payout_imports ADD CONSTRAINT payroll_1c_payout_imports_action_check
  CHECK (action IN ('new', 'replace', 'enrich', 'relink', 'cancel', 'restore', 'rollback', 'adopt', 'supersede'));
ALTER TABLE payroll_1c_payout_imports DROP CONSTRAINT IF EXISTS payroll_1c_payout_imports_source_format_check;
ALTER TABLE payroll_1c_payout_imports ADD CONSTRAINT payroll_1c_payout_imports_source_format_check
  CHECK (source_format IN ('zup2', 'external', 'api'));
ALTER TABLE payroll_1c_payout_imports DROP CONSTRAINT IF EXISTS payroll_1c_payout_imports_cancel_snapshot;
ALTER TABLE payroll_1c_payout_imports ADD CONSTRAINT payroll_1c_payout_imports_cancel_snapshot
  CHECK (action NOT IN ('cancel', 'rollback', 'adopt', 'supersede') OR previous_lines IS NOT NULL);
ALTER TABLE payroll_1c_payout_imports DROP CONSTRAINT IF EXISTS payroll_1c_payout_imports_adopt_snapshot;
ALTER TABLE payroll_1c_payout_imports ADD CONSTRAINT payroll_1c_payout_imports_adopt_snapshot
  CHECK (action <> 'adopt' OR previous_header IS NOT NULL);
ALTER TABLE payroll_1c_payout_imports ADD COLUMN IF NOT EXISTS data_api_key_id UUID REFERENCES data_api_keys(id) ON DELETE SET NULL;
ALTER TABLE payroll_1c_payout_imports ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES payroll_1c_payout_api_batches(batch_id) ON DELETE SET NULL;

-- Снятые строки «ЗП к выплате»: снимок строки (поля payroll_1c_payout_lines), сотрудник и месяц, кем снята.
CREATE TABLE IF NOT EXISTS payroll_1c_payout_to_pay_superseded (
  id                 BIGSERIAL PRIMARY KEY,
  document_id        BIGINT NOT NULL REFERENCES payroll_1c_payout_documents(id) ON DELETE CASCADE,
  line               JSONB NOT NULL CHECK (jsonb_typeof(line) = 'object' AND line ? 'line_no'),
  employee_id        INTEGER NOT NULL,
  month              DATE NOT NULL CHECK (month = date_trunc('month', month)::date),
  superseded_by_guid UUID NOT NULL,
  batch_id           UUID REFERENCES payroll_1c_payout_api_batches(batch_id) ON DELETE SET NULL,
  superseded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_1c_payout_to_pay_superseded_line_uniq
  ON payroll_1c_payout_to_pay_superseded (document_id, ((line ->> 'line_no')::int));

-- Ведомость из API меняет только API: документ (UPDATE, DELETE) и строки (INSERT, UPDATE, DELETE). Исключение —
-- обнуление сотрудника строки (ON DELETE SET NULL при удалении карточки): прочие поля строки при этом не меняются.
CREATE OR REPLACE FUNCTION payroll_1c_payout_api_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  doc RECORD;
  writer TEXT := COALESCE(current_setting('fot.payout_writer', true), '');
BEGIN
  IF writer = 'api' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'payroll_1c_payout_documents' THEN
    IF OLD.origin = 'api' OR (TG_OP = 'UPDATE' AND NEW.origin = 'api') THEN
      RAISE EXCEPTION 'Ведомость № % от % пришла из 1С по API — менять её можно только через API', OLD.doc_number, OLD.doc_date;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT d.origin, d.doc_number, d.doc_date INTO doc
    FROM payroll_1c_payout_documents d
   WHERE d.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.document_id ELSE OLD.document_id END;
  IF doc.origin IS DISTINCT FROM 'api' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.employee_id IS NULL AND OLD.employee_id IS NOT NULL
     AND (to_jsonb(NEW) - 'employee_id') = (to_jsonb(OLD) - 'employee_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Ведомость № % от % пришла из 1С по API — менять её строки можно только через API', doc.doc_number, doc.doc_date;
END;
$$;

DROP TRIGGER IF EXISTS payroll_1c_payout_documents_api_guard ON payroll_1c_payout_documents;
CREATE TRIGGER payroll_1c_payout_documents_api_guard
  BEFORE UPDATE OR DELETE ON payroll_1c_payout_documents
  FOR EACH ROW EXECUTE FUNCTION payroll_1c_payout_api_guard();
DROP TRIGGER IF EXISTS payroll_1c_payout_lines_api_guard ON payroll_1c_payout_lines;
CREATE TRIGGER payroll_1c_payout_lines_api_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_1c_payout_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_1c_payout_api_guard();

COMMENT ON COLUMN payroll_1c_payout_documents.origin IS
  'Откуда ведомость: api (1С по API, меняет только API), file (кнопка или скрипт), register, generator, brigade_sheet, '
  'to_pay («ЗП к выплате» ЗУП2: строка снимается, когда по API пришла зарплата или премия сотрудника за месяц).';
COMMENT ON TABLE payroll_1c_payout_to_pay_superseded IS
  'Снятые строки «ЗП к выплате» (origin to_pay): снимок, сотрудник, месяц и ГУИД ведомости API, которая её заменила.';
COMMENT ON TABLE payroll_1c_payout_api_states IS
  'Ведомости выплаты по API: версия 1С и состояние по ГУИДу (действует / отменена); надгробие — отмена без документа.';
COMMENT ON TABLE payroll_1c_payout_api_batches IS 'Выгрузки ведомостей по API со снимками «до» — для отката.';

COMMIT;
