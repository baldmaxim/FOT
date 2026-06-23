-- 189_contractor_pass_birth_date.sql
-- Дата рождения держателя пропуска. Заполняет подрядчик в ЛК
-- (модалка «Документы», поле справа от «Дата выдачи документа»).
-- Plain-text/дата, как и остальные поля документов (см. 187/188).

BEGIN;

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS birth_date date NULL;

COMMIT;
