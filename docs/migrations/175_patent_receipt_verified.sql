-- 175: отметка «проверено вручную» для чеков за патент.
-- Отдельное поле от needs_review (качество распознавания) — семантика «проверено человеком».
ALTER TABLE patent_payment_receipts
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES user_profiles(id),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
