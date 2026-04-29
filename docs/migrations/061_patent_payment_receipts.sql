-- Migration 061: распознавание чеков НДФЛ за патент.
-- 1) Расширяем documents полями статуса распознавания.
-- 2) Создаём типизированную таблицу patent_payment_receipts.

BEGIN;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS recognition_status TEXT
    CHECK (recognition_status IS NULL OR recognition_status IN ('pending','processing','done','failed','needs_review'))
    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS recognition_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recognized_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS patent_payment_receipts (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,

  payment_date DATE,
  payment_amount NUMERIC(12,2),
  commission NUMERIC(12,2),
  total_amount NUMERIC(12,2),
  payer_full_name TEXT,
  payer_inn TEXT,
  payer_passport TEXT,
  document_number TEXT,

  payment_purpose TEXT,
  patent_number TEXT,
  patent_issue_date DATE,
  kbk TEXT,
  oktmo TEXT,
  uin TEXT,
  recipient_name TEXT,
  recipient_inn TEXT,
  recipient_kpp TEXT,
  recipient_bank_name TEXT,
  recipient_bank_bic TEXT,
  recipient_account TEXT,
  recipient_corr_account TEXT,

  payer_bank_name TEXT,
  payer_bank_bic TEXT,
  payer_account TEXT,
  payment_method TEXT,

  source_type TEXT,
  raw_response JSONB,
  confidence NUMERIC(3,2),
  recognition_model TEXT,
  prompt_tokens INT,
  completion_tokens INT,
  cost_usd NUMERIC(8,5),

  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by UUID REFERENCES user_profiles(id),
  reviewed_at TIMESTAMPTZ,
  manually_edited BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ppr_employee_id ON patent_payment_receipts(employee_id);
CREATE INDEX IF NOT EXISTS idx_ppr_payment_date ON patent_payment_receipts(payment_date);
CREATE INDEX IF NOT EXISTS idx_ppr_needs_review ON patent_payment_receipts(needs_review) WHERE needs_review = TRUE;

NOTIFY pgrst, 'reload schema';

COMMIT;
