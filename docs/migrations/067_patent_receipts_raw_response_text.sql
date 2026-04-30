-- 066_patent_receipts_raw_response_text.sql
-- Шифруем app-level чувствительные поля распознанного чека через AES-256-GCM.
-- Поскольку encryptionService возвращает строку формата iv:authTag:ciphertext,
-- raw_response (JSONB) переводим в TEXT — иначе шифр-текст не лезет в jsonb.

ALTER TABLE patent_payment_receipts
  ALTER COLUMN raw_response TYPE TEXT USING raw_response::TEXT;
