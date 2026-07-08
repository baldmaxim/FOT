-- 211_newdb_checks.sql
-- История проверок физлиц через внешний сервис newdb.net:
--   * РКЛ (реестр контролируемых лиц, method=rkl)
--   * Патент (method=foreign_patent)
-- Таблица аудиторская: снимок ПД на момент проверки + сырой ответ провайдера.
-- Токен API хранится в system_settings (зашифрован), не здесь.

BEGIN;

CREATE TABLE IF NOT EXISTS public.newdb_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,

  check_type text NOT NULL
    CHECK (check_type IN ('rkl', 'patent')),
  subject_kind text NOT NULL DEFAULT 'contractor_pass'
    CHECK (subject_kind IN ('contractor_pass', 'employee')),

  -- Субъект проверки
  contractor_pass_id uuid NULL REFERENCES public.contractor_passes(id) ON DELETE SET NULL,
  org_department_id uuid NULL REFERENCES public.org_departments(id) ON DELETE SET NULL,

  -- Снимок ПД на момент проверки (исходный full_name сохраняем целиком)
  full_name text NULL,
  birth_date date NULL,
  passport_series_number text NULL,
  patent_number text NULL,
  citizenship text NULL,

  -- Результат
  status text NOT NULL DEFAULT 'error'
    CHECK (status IN ('clean', 'found', 'invalid', 'error', 'not_applicable')),
  request_sent boolean NOT NULL DEFAULT false,
  newdb_task_id text NULL,
  provider_status text NULL,       -- сырой registry_status / doc_status провайдера
  result_summary text NULL,        -- краткий вывод для UI
  raw_response jsonb NULL,         -- сырой ответ API (ПДн; отдаётся только на edit)
  newdb_qid text NULL,
  balance integer NULL,
  error_message text NULL
);

-- Под выборку «последний РКЛ / последний Патент» по пропуску.
CREATE INDEX IF NOT EXISTS newdb_checks_pass_type_created_idx
  ON public.newdb_checks(contractor_pass_id, check_type, created_at DESC);

CREATE INDEX IF NOT EXISTS newdb_checks_org_created_idx
  ON public.newdb_checks(org_department_id, created_at DESC);

COMMIT;
