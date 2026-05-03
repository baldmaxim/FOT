-- Хранение текста ошибки распознавания чека (LLM ответ невалиден / OpenRouter недоступен и т.п.)
-- При status='failed' — заполняется. При done/needs_review/processing — обнуляется.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS recognition_error TEXT NULL;

COMMENT ON COLUMN documents.recognition_error IS
  'Текст ошибки последней попытки распознавания чека (≤1000 символов). NULL если успех или попытка не делалась.';
