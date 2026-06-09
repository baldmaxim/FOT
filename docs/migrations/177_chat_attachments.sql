-- 176: вложение файла в сообщение чата.
-- Один файл на сообщение. Метаданные в JSONB: { key, name, size, mime }.
-- Сам файл лежит в приватном R2, доступ — через короткоживущие подписанные URL.
-- Применять вручную через psql на проде (авто-миграций нет).

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment JSONB;
