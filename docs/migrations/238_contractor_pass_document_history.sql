-- 238: История изменений документов держателя подрядного пропуска.
-- Снапшот ПРЕЖНИХ значений пишется перед каждым изменением документов
-- (админ в «Мониторинге», подрядчик до подачи, освобождение пропуска).
-- Аудиторская таблица: переживает удаление пропуска (FK SET NULL +
-- денормализованные pass_number/org_department_id/holder_name).
-- Применять ДО деплоя бэка.

CREATE TABLE IF NOT EXISTS public.contractor_pass_document_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id uuid REFERENCES public.contractor_passes(id) ON DELETE SET NULL,
  pass_number text NOT NULL,
  org_department_id uuid,
  holder_name text,
  passport_series_number text,
  passport_issue_date date,
  birth_date date,
  citizenship text,
  patent_number text,
  patent_issue_date date,
  patent_blank_number text,
  has_residence_permit boolean,
  residence_permit_number text,
  changed_fields text[] NOT NULL,
  changed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  changed_by_name text,
  changed_source text NOT NULL DEFAULT 'admin'
    CHECK (changed_source IN ('admin', 'contractor', 'clear_holder')),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cpdh_pass
  ON public.contractor_pass_document_history (pass_id, changed_at DESC);
