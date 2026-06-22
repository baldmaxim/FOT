-- 187_contractor_pass_documents.sql
-- Персональные документы держателя пропуска: паспорт и патент.
-- Заполняет подрядчик в ЛК (кнопка «Документы» в строке пропуска).
-- Хранятся plain-text — как и holder_name (см. CLAUDE.md: ФИО не шифруются).

BEGIN;

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS passport_series_number text NULL,
  ADD COLUMN IF NOT EXISTS passport_issue_date date NULL,
  ADD COLUMN IF NOT EXISTS patent_number text NULL,
  ADD COLUMN IF NOT EXISTS patent_issue_date date NULL;

COMMIT;
