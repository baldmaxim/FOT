-- 100_contractor_domain.sql
-- Доменные таблицы подрядчиков: пропуска, заявки на согласование, ростер
-- людей. CHECK-enum (стиль 054_correction_approval.sql).

BEGIN;

-- Пропуска: нумерованные профили в папке подрядчика в Sigur.
-- issued (профиль-заглушка создан) → assigned (подрядчик назначил ФИО,
-- заявка отправлена) → applied (админ согласовал, профиль переименован)
-- → revoked (резерв).
CREATE TABLE IF NOT EXISTS public.contractor_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE RESTRICT,
  pass_number text NOT NULL,
  sigur_employee_id bigint NULL,
  card_uid text NULL,
  status text NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'assigned', 'applied', 'revoked')),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contractor_passes_unique UNIQUE (org_department_id, pass_number)
);

CREATE INDEX IF NOT EXISTS contractor_passes_org_status_idx
  ON public.contractor_passes(org_department_id, status);

-- Заявки на согласование (пакет изменений подрядчика).
-- pending → approved | rejected | partially_applied.
CREATE TABLE IF NOT EXISTS public.contractor_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE RESTRICT,
  submitted_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'partially_applied')),
  reviewed_by uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz NULL,
  comment text NULL,
  apply_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contractor_submissions_pending_idx
  ON public.contractor_submissions(org_department_id)
  WHERE status = 'pending';

-- Ростер людей подрядчика.
-- active (есть в Sigur, синхронизирован) / pending_add (добавлен подрядчиком)
-- / pending_remove (помечен на удаление) / removed (профиль удалён).
CREATE TABLE IF NOT EXISTS public.contractor_roster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  sigur_employee_id bigint NULL,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'pending_add', 'pending_remove', 'removed')),
  assigned_pass_id uuid NULL REFERENCES public.contractor_passes(id) ON DELETE SET NULL,
  submission_id uuid NULL REFERENCES public.contractor_submissions(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contractor_roster_org_state_idx
  ON public.contractor_roster(org_department_id, state);
CREATE INDEX IF NOT EXISTS contractor_roster_submission_idx
  ON public.contractor_roster(submission_id);
-- Один Sigur-сотрудник = одна строка ростера в рамках организации.
CREATE UNIQUE INDEX IF NOT EXISTS contractor_roster_org_sigur_uniq
  ON public.contractor_roster(org_department_id, sigur_employee_id)
  WHERE sigur_employee_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
