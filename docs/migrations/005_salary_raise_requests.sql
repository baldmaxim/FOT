-- 005: Заявка на повышение оклада
-- Таблицы: salary_raise_requests, salary_raise_attachments

CREATE TABLE IF NOT EXISTS salary_raise_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  author_user_id UUID NOT NULL REFERENCES user_profiles(id),
  status TEXT NOT NULL DEFAULT 'draft',
  employee_snapshot JSONB NOT NULL,
  request_type TEXT NOT NULL,
  requested_salary NUMERIC(12,2) NOT NULL,
  raise_percentage NUMERIC(5,2) NOT NULL,
  desired_effective_date DATE NOT NULL,
  reason_brief TEXT NOT NULL,
  achievements JSONB NOT NULL DEFAULT '[]',
  responsibility_changes JSONB NOT NULL DEFAULT '{}',
  self_assessment JSONB NOT NULL DEFAULT '{}',
  supervisor_review JSONB,
  supervisor_reviewer_id UUID,
  supervisor_reviewed_at TIMESTAMPTZ,
  hr_review JSONB,
  hr_reviewer_id UUID,
  hr_reviewed_at TIMESTAMPTZ,
  finance_review JSONB,
  finance_reviewer_id UUID,
  finance_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS salary_raise_attachments (
  id SERIAL PRIMARY KEY,
  salary_raise_id INTEGER NOT NULL REFERENCES salary_raise_requests(id) ON DELETE CASCADE,
  achievement_index INTEGER,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  uploaded_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_salary_raise_employee ON salary_raise_requests(employee_id);
CREATE INDEX idx_salary_raise_status ON salary_raise_requests(status);
CREATE INDEX idx_salary_raise_author ON salary_raise_requests(author_user_id);
CREATE INDEX idx_salary_raise_att_request ON salary_raise_attachments(salary_raise_id);
