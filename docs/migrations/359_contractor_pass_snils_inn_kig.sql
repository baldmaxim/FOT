BEGIN;
SET LOCAL lock_timeout = '5s';

-- 359: СНИЛС, ИНН и КиГ (карта иностранного гражданина) в документах держателя подрядного пропуска.
--
-- Поля необязательные: полнота комплекта (✓ на кнопке «Документы», гейт отправки, SQL
-- documents_complete) от них не зависит. Храним как паспорт и патент — открытым текстом:
--   snils         — 11 цифр без маски;
--   inn           — 12 цифр (ИНН физлица);
--   kig           — номер КиГ, верхний регистр; только у иностранцев (не Россия), иначе NULL;
--   kig_end_date  — срок действия КиГ.
-- Те же колонки — в истории изменений документов (снимки прежних значений, миграция 238).
--
-- Новый источник истории 'holder_reset': документы очищены автоматически при смене или снятии
-- держателя («Сменить владельца», «Отклонить выделенные», возврат в общий пул, замена/стирание
-- ФИО подрядчиком), чтобы документы ушедшего человека не достались новому.
--
-- Применять ДО деплоя бэкенда: новый бэк читает и пишет эти колонки.

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS snils text,
  ADD COLUMN IF NOT EXISTS inn text,
  ADD COLUMN IF NOT EXISTS kig text,
  ADD COLUMN IF NOT EXISTS kig_end_date date;

ALTER TABLE public.contractor_pass_document_history
  ADD COLUMN IF NOT EXISTS snils text,
  ADD COLUMN IF NOT EXISTS inn text,
  ADD COLUMN IF NOT EXISTS kig text,
  ADD COLUMN IF NOT EXISTS kig_end_date date;

ALTER TABLE public.contractor_pass_document_history
  DROP CONSTRAINT IF EXISTS contractor_pass_document_history_changed_source_check;
ALTER TABLE public.contractor_pass_document_history
  ADD CONSTRAINT contractor_pass_document_history_changed_source_check
  CHECK (changed_source IN ('admin', 'contractor', 'clear_holder', 'holder_reset'));

COMMIT;
