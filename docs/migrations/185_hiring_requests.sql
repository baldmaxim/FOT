-- 185_hiring_requests.sql
-- Модуль «Заявки для HR» (подбор персонала) на странице «Управление кадрами».
-- Применять вручную: psql "$DATABASE_URL" -f docs/migrations/185_hiring_requests.sql
-- ВАЖНО: применить ДО выката бэкенда (контроллер зависит от таблиц).

BEGIN;

-- =========================================================================
-- Заявка на поиск сотрудника
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.hiring_requests (
  id                     BIGSERIAL PRIMARY KEY,
  author_user_id         UUID NOT NULL REFERENCES public.user_profiles(id),
  author_employee_id     INTEGER REFERENCES public.employees(id),
  department_id          UUID REFERENCES public.org_departments(id),  -- отдел заявителя (скоуп/аналитика)
  stage                  TEXT NOT NULL DEFAULT 'new'
                           CHECK (stage IN ('new','in_progress','interview','offer','closed','cancelled','rework')),
  is_urgent              BOOLEAN NOT NULL DEFAULT FALSE,
  rework_reason          TEXT,
  -- поля заявки (из первичной формы)
  start_work_date        DATE,
  deadline               DATE,          -- срок закрытия (для «% в срок» / «просрочено»)
  customer_name          TEXT,
  headcount              INTEGER NOT NULL DEFAULT 1 CHECK (headcount >= 1),
  position_title         TEXT NOT NULL,
  duties                 TEXT,
  experience             TEXT,
  requirements           TEXT,
  software               TEXT,
  gender                 TEXT CHECK (gender IN ('any','male','female')),
  salary_level           TEXT,
  hh_vacancy_url         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reactivated_at         TIMESTAMPTZ,   -- момент пересдачи после доработки (для «дней в работе»)
  applicant_finalized_at TIMESTAMPTZ,   -- заявитель утвердил финальный набор
  closed_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hiring_requests_stage  ON public.hiring_requests(stage);
CREATE INDEX IF NOT EXISTS idx_hiring_requests_author ON public.hiring_requests(author_employee_id);
CREATE INDEX IF NOT EXISTS idx_hiring_requests_dept   ON public.hiring_requests(department_id);

-- =========================================================================
-- Пул рекрутеров отдела подбора. Членство = «является рекрутером».
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.hiring_recruiters (
  id          BIGSERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  added_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hiring_recruiter_active
  ON public.hiring_recruiters(employee_id) WHERE is_active = TRUE;

-- =========================================================================
-- Ответственные за заявку — несколько на заявку; при наличии — ровно один primary.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.hiring_request_assignees (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES public.hiring_requests(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hiring_assignee_active
  ON public.hiring_request_assignees(request_id, employee_id) WHERE is_active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hiring_assignee_primary
  ON public.hiring_request_assignees(request_id) WHERE is_active = TRUE AND is_primary = TRUE;
CREATE INDEX IF NOT EXISTS idx_hiring_assignee_emp
  ON public.hiring_request_assignees(employee_id) WHERE is_active = TRUE;

-- =========================================================================
-- Кандидаты (воронка). Два отзыва + флаг утверждения заявителем.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.hiring_candidates (
  id                 BIGSERIAL PRIMARY KEY,
  request_id         BIGINT NOT NULL REFERENCES public.hiring_requests(id) ON DELETE CASCADE,
  full_name          TEXT NOT NULL,
  hh_resume_url      TEXT,
  phone              TEXT,
  salary_expectation TEXT,
  status             TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','screening','interview','offer','accepted','reserve','reject')),
  interview_at       TIMESTAMPTZ,
  seeker_feedback    TEXT,    -- отзыв соискателя (вводит HR)
  applicant_feedback TEXT,    -- отзыв заявителя (вводит заявитель или HR)
  applicant_approved BOOLEAN NOT NULL DEFAULT FALSE,  -- «Кандидат выбран» заявителем
  approved_by        UUID REFERENCES public.user_profiles(id),
  approved_at        TIMESTAMPTZ,
  created_by         UUID REFERENCES public.user_profiles(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hiring_candidates_req ON public.hiring_candidates(request_id);

-- =========================================================================
-- Файлы заявки (отдельно от employee-центричного documents). R2-ключ напрямую.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.hiring_request_files (
  id           BIGSERIAL PRIMARY KEY,
  request_id   BIGINT NOT NULL REFERENCES public.hiring_requests(id) ON DELETE CASCADE,
  candidate_id BIGINT REFERENCES public.hiring_candidates(id) ON DELETE SET NULL,
  r2_key       TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  file_size    BIGINT,
  mime_type    TEXT,
  uploaded_by  UUID REFERENCES public.user_profiles(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hiring_files_req ON public.hiring_request_files(request_id);

-- =========================================================================
-- Единый таймлайн заявки.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.hiring_request_events (
  id             BIGSERIAL PRIMARY KEY,
  request_id     BIGINT NOT NULL REFERENCES public.hiring_requests(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES public.user_profiles(id),
  kind           TEXT NOT NULL CHECK (kind IN (
                   'comment','link','stage_change','assign','unassign','rework','resubmit',
                   'urgent','candidate','file','approve','finalize','unfinalize')),
  body           TEXT,
  link_url       TEXT,
  from_stage     TEXT,
  to_stage       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hiring_events_req ON public.hiring_request_events(request_id, created_at);

-- =========================================================================
-- Грант доступа к вкладке «Заявки для HR» (view) — копируем со страницы
-- «Управление кадрами» (/staff-control): кто видит её, видит и подбор.
-- Идемпотентно через NOT EXISTS. Рекрутеры/руководитель отдела кадров
-- получают доступ динамически (auto-access), а не через этот грант.
-- =========================================================================
INSERT INTO public.role_page_access (role_code, page_path, can_view, can_edit)
SELECT rpa.role_code, '/staff-control/hiring', TRUE, FALSE
  FROM public.role_page_access rpa
 WHERE rpa.page_path = '/staff-control' AND rpa.can_view = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM public.role_page_access x
      WHERE x.role_code = rpa.role_code AND x.page_path = '/staff-control/hiring'
   );

COMMIT;
