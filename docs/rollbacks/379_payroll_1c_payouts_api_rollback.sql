-- Откат 379: ведомости выплаты по API.
--
-- Порядок: сначала вернуть бэкенд на версию до 379, затем этот файл. Если по API уже пришли ведомости, откат
-- останавливается: сначала откатите выгрузки (scripts/rollback-payouts-api-batch.ts) или решите, что с ними делать —
-- после отката они стали бы обычными ведомостями без защиты, комментариев и состояния.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_1c_payout_documents WHERE origin = 'api') THEN
    RAISE EXCEPTION 'Есть ведомости, пришедшие по API (%), — откат остановлен',
      (SELECT count(*) FROM payroll_1c_payout_documents WHERE origin = 'api');
  END IF;
  IF EXISTS (SELECT 1 FROM payroll_1c_payout_lines WHERE resolution = 'auto_id_fot') THEN
    RAISE EXCEPTION 'Есть строки, сопоставленные по ID_FOT, — откат остановлен';
  END IF;
  IF EXISTS (SELECT 1 FROM payroll_1c_payout_imports
              WHERE action IN ('cancel', 'restore', 'rollback', 'adopt', 'supersede') OR source_format = 'api') THEN
    RAISE EXCEPTION 'В журнале есть действия API — откат остановлен';
  END IF;
  IF to_regclass('payroll_1c_payout_to_pay_superseded') IS NOT NULL
     AND EXISTS (SELECT 1 FROM payroll_1c_payout_to_pay_superseded) THEN
    RAISE EXCEPTION 'Есть снятые строки «ЗП к выплате» — сначала откатите выгрузки API, иначе строки потеряются';
  END IF;
END $$;

DROP TRIGGER IF EXISTS payroll_1c_payout_documents_api_guard ON payroll_1c_payout_documents;
DROP TRIGGER IF EXISTS payroll_1c_payout_lines_api_guard ON payroll_1c_payout_lines;
DROP FUNCTION IF EXISTS payroll_1c_payout_api_guard();

ALTER TABLE payroll_1c_payout_imports DROP COLUMN IF EXISTS batch_id;
ALTER TABLE payroll_1c_payout_imports DROP COLUMN IF EXISTS data_api_key_id;
DROP TABLE IF EXISTS payroll_1c_payout_to_pay_superseded;
ALTER TABLE payroll_1c_payout_imports DROP CONSTRAINT IF EXISTS payroll_1c_payout_imports_adopt_snapshot;
ALTER TABLE payroll_1c_payout_imports DROP CONSTRAINT IF EXISTS payroll_1c_payout_imports_cancel_snapshot;
ALTER TABLE payroll_1c_payout_imports DROP CONSTRAINT IF EXISTS payroll_1c_payout_imports_source_format_check;
ALTER TABLE payroll_1c_payout_imports ADD CONSTRAINT payroll_1c_payout_imports_source_format_check
  CHECK (source_format IN ('zup2', 'external'));
ALTER TABLE payroll_1c_payout_imports DROP CONSTRAINT IF EXISTS payroll_1c_payout_imports_action_check;
ALTER TABLE payroll_1c_payout_imports ADD CONSTRAINT payroll_1c_payout_imports_action_check
  CHECK (action IN ('new', 'replace', 'enrich', 'relink'));

DROP TABLE IF EXISTS payroll_1c_payout_api_states;
DROP TABLE IF EXISTS payroll_1c_payout_api_batches;
ALTER TABLE data_api_keys DROP COLUMN IF EXISTS allow_payroll_payouts_import;

ALTER TABLE payroll_1c_payout_lines DROP CONSTRAINT IF EXISTS payroll_1c_payout_lines_resolution_check;
ALTER TABLE payroll_1c_payout_lines ADD CONSTRAINT payroll_1c_payout_lines_resolution_check
  CHECK (resolution IN ('auto_id_all', 'confirmed', 'unmatched'));
ALTER TABLE payroll_1c_payout_lines DROP COLUMN IF EXISTS id_fot_1c;
ALTER TABLE payroll_1c_payout_lines DROP COLUMN IF EXISTS basis;

DROP INDEX IF EXISTS payroll_1c_payout_documents_org_number_date_uniq;
ALTER TABLE payroll_1c_payout_documents DROP COLUMN IF EXISTS comment;
ALTER TABLE payroll_1c_payout_documents DROP COLUMN IF EXISTS origin;

DELETE FROM schema_migrations WHERE filename = '379_payroll_1c_payouts_api.sql';

COMMIT;
