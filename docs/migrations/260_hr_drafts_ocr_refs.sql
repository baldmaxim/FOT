-- 260_hr_drafts_ocr_refs.sql
-- Инфраструктура кадрового модуля: черновики мастера «Добавить сотрудника»,
-- резервирование идентификаторов (антидубль), очередь распознавания, внешние
-- ссылки для идемпотентного переноса из PassDesk и staging несопоставленных.
--
-- Черновик — контейнер для сканов до создания сотрудника. Сотрудника создаёт
-- существующий POST /api/employees; черновик помнит employee_id и результат
-- прикрепления (attach), чтобы после сбоя повторялось только прикрепление.
--
-- hr_identity_claims: PK (claim_type, claim_hash) — два черновика/сотрудника с одним
-- СНИЛС/ИНН/паспортом не пройдут одновременно.
--
-- Зависит от 259. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_hr_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'employee_created_pending_attach', 'attached', 'expired')),
  payload_enc text,
  key_version varchar(16),
  employee_id integer REFERENCES public.employees(id) ON DELETE SET NULL,
  attach_error text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_hr_drafts IS
  'Черновики мастера «Добавить сотрудника»: контейнер для сканов до создания employees. Сотрудника создаёт существующий POST /api/employees, черновик лишь помнит employee_id и результат прикрепления.';

CREATE INDEX IF NOT EXISTS ehd_owner_idx ON public.employee_hr_drafts(created_by, state);
CREATE INDEX IF NOT EXISTS ehd_expires_idx ON public.employee_hr_drafts(expires_at) WHERE state = 'draft';

CREATE TABLE IF NOT EXISTS public.hr_identity_claims (
  claim_type text NOT NULL CHECK (claim_type IN ('snils', 'inn', 'passport')),
  claim_hash char(64) NOT NULL,
  draft_id uuid REFERENCES public.employee_hr_drafts(id) ON DELETE CASCADE,
  employee_id integer REFERENCES public.employees(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_type, claim_hash),
  CHECK (draft_id IS NOT NULL OR employee_id IS NOT NULL)
);

COMMENT ON TABLE public.hr_identity_claims IS
  'Резерв идентификаторов (HMAC-хэш СНИЛС/ИНН/паспорта) за черновиком или сотрудником — защита от параллельного создания дублей.';

CREATE INDEX IF NOT EXISTS hic_employee_idx ON public.hr_identity_claims(employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.hr_ocr_jobs (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL UNIQUE REFERENCES public.documents(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased', 'done', 'failed', 'needs_review')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.hr_ocr_jobs IS
  'Очередь распознавания сканов hr_* (DB-очередь: FOR UPDATE SKIP LOCKED, lease, backoff).';

CREATE INDEX IF NOT EXISTS hoj_pick_idx ON public.hr_ocr_jobs(next_run_at) WHERE state IN ('queued', 'leased');

CREATE TABLE IF NOT EXISTS public.hr_external_refs (
  source_system text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('document', 'employee_profile')),
  source_id text NOT NULL,
  entity_id bigint NOT NULL,
  sha256 char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, entity_type, source_id)
);

COMMENT ON TABLE public.hr_external_refs IS
  'Внешние идентификаторы (PassDesk) → сущности FOT. Гарантирует идемпотентность переноса (повтор не создаёт строк/файлов).';

CREATE INDEX IF NOT EXISTS her_entity_idx ON public.hr_external_refs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS public.hr_profile_import_staging (
  passdesk_id uuid PRIMARY KEY,
  full_name text NOT NULL,
  birth_date date,
  citizenship text,
  counterparty text,
  is_active boolean,
  match_state text NOT NULL DEFAULT 'unmatched' CHECK (match_state IN ('unmatched', 'candidate', 'ambiguous', 'linked', 'created')),
  candidate_employee_ids integer[],
  payload_enc text NOT NULL,
  key_version varchar(16),
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  linked_employee_id integer REFERENCES public.employees(id) ON DELETE SET NULL,
  linked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.hr_profile_import_staging IS
  'Несопоставленные/неоднозначные сотрудники PassDesk (payload зашифрован). Доступ — только is_admin.';

CREATE INDEX IF NOT EXISTS hpis_state_idx ON public.hr_profile_import_staging(match_state);

COMMIT;
