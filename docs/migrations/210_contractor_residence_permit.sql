-- 210_contractor_residence_permit.sql
-- ВНЖ (вид на жительство) держателя подрядного пропуска.
-- Если у гражданина патентной страны есть ВНЖ — патент не требуется: комплект
-- документов считается полным при заполненном номере ВНЖ вместо полей патента.
-- Логика полноты продублирована в contractor-docs.service (isDocsComplete) и в
-- SQL documents_complete (contractor-admin.controller) — держать в синхроне.

BEGIN;

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS has_residence_permit    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS residence_permit_number text NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
