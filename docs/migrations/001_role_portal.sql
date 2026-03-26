-- Миграция: Ролевой портал (Сотрудник / Руководитель / HR / Admin)
-- Дата: 2026-03-26

-- 1. Новая роль HR в enum
ALTER TYPE employee_position_type ADD VALUE IF NOT EXISTS 'hr' AFTER 'header';

-- 2. Заявления на отпуск/больничный/удалёнку
CREATE TABLE IF NOT EXISTS leave_requests (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  request_type    TEXT NOT NULL CHECK (request_type IN (
    'vacation','sick_leave','remote','dayoff','business_trip','certificate'
  )),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','approved','rejected','cancelled'
  )),
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  reason          TEXT,
  reviewer_id     UUID REFERENCES user_profiles(id),
  reviewed_at     TIMESTAMPTZ,
  review_comment  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_status ON leave_requests(organization_id, status);

-- 3. Документы (ссылки на R2)
CREATE TABLE IF NOT EXISTS documents (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  leave_request_id BIGINT REFERENCES leave_requests(id),
  category         TEXT NOT NULL CHECK (category IN (
    'certificate','scan','approval','payslip','other'
  )),
  file_name        TEXT NOT NULL,
  file_size        INTEGER NOT NULL,
  mime_type        TEXT NOT NULL,
  r2_key           TEXT NOT NULL,
  uploaded_by      UUID NOT NULL REFERENCES user_profiles(id),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_employee ON documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_documents_leave_request ON documents(leave_request_id);

-- 4. Расчётные листки
CREATE TABLE IF NOT EXISTS payslips (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  period          TEXT NOT NULL,
  gross_amount    NUMERIC(12,2),
  net_amount      NUMERIC(12,2),
  deductions      NUMERIC(12,2),
  details         JSONB,
  document_id     BIGINT REFERENCES documents(id),
  created_by      UUID NOT NULL REFERENCES user_profiles(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, period)
);
CREATE INDEX IF NOT EXISTS idx_payslips_employee ON payslips(employee_id);

-- 5. История выплат
CREATE TABLE IF NOT EXISTS payments (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  payment_date    DATE NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  payment_type    TEXT NOT NULL CHECK (payment_type IN (
    'salary','advance','bonus','vacation_pay','sick_pay','other'
  )),
  description     TEXT,
  period          TEXT,
  created_by      UUID NOT NULL REFERENCES user_profiles(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_employee ON payments(employee_id);
CREATE INDEX IF NOT EXISTS idx_payments_org_date ON payments(organization_id, payment_date);

-- 6. Согласование табелей
CREATE TABLE IF NOT EXISTS timesheet_approvals (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  department_id   UUID NOT NULL REFERENCES org_departments(id),
  period          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','submitted','approved','rejected'
  )),
  submitted_by    UUID REFERENCES user_profiles(id),
  submitted_at    TIMESTAMPTZ,
  reviewed_by     UUID REFERENCES user_profiles(id),
  reviewed_at     TIMESTAMPTZ,
  review_comment  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(department_id, period)
);
