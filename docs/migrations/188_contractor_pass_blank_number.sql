-- 188_contractor_pass_blank_number.sql
-- Номер бланка патента держателя пропуска. Заполняет подрядчик в ЛК
-- (модалка «Документы», поле справа от «Дата выдачи патента»).
-- Plain-text, как и остальные поля документов (см. 187_contractor_pass_documents.sql).

BEGIN;

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS patent_blank_number text NULL;

COMMIT;
