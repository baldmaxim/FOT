-- 116_contractor_pass_workflow_v2.sql
-- Двухэтапный workflow выдачи пропусков подрядчику.
--   Этап A: общий пул свободных пропусков в Sigur (папка выбирается админом
--           через UI, id сохраняется в system_settings).
--   Этап B: назначение пула подрядчику (перенос профилей в его папку).
--   Этап C: подрядчик вписывает ФИО (с историей и сменой владельца).
--   Этап D: админ согласовывает поштучно/массово, открывает пропуска.
--
-- Изменения:
--   * lifecycle статусы contractor_passes расширены (in_pool/blocked).
--   * новая колонка approval_status (поштучный статус в заявке).
--   * новая колонка is_active (для мониторинга «активен/не активен»).
--   * новая таблица contractor_pass_holders (история ФИО владельца).
--   * новая таблица contractor_submission_decisions (история одобрений).
--   * настройка id папки общего пула в system_settings.
--   * частичный uniq индекс на pass_number в пуле (org_department_id IS NULL).
--   * переименование label страницы /admin/contractor-approvals.

BEGIN;

-- =====================================================================
-- 116.1. Настройка папки общего пула.
-- =====================================================================
INSERT INTO system_settings (key, value, description)
VALUES (
  'contractor.free_pool.sigur_department_id',
  NULL,
  'Sigur-id папки общего пула пропусков (выбирается админом через UI; саму папку создаёт админ вручную в Sigur)'
)
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 116.2. Доработка contractor_passes.
-- =====================================================================

-- org_department_id может быть NULL для записей в общем пуле.
ALTER TABLE public.contractor_passes
  ALTER COLUMN org_department_id DROP NOT NULL;

-- Маппинг существующих статусов до смены CHECK-constraint:
--   issued → assigned (профиль создан в папке подрядчика, ждёт ФИО)
--   assigned + submission_id → submitted (в составе заявки)
--   applied → applied
--   revoked → revoked
UPDATE public.contractor_passes
   SET status = 'submitted'
 WHERE status = 'assigned'
   AND submission_id IS NOT NULL;

UPDATE public.contractor_passes
   SET status = 'assigned'
 WHERE status = 'issued';

-- Расширяем lifecycle: новые статусы in_pool, awaiting_fio, submitted, blocked.
ALTER TABLE public.contractor_passes
  DROP CONSTRAINT IF EXISTS contractor_passes_status_check;
ALTER TABLE public.contractor_passes
  ADD CONSTRAINT contractor_passes_status_check
  CHECK (status IN (
    'in_pool',       -- в общей папке Sigur, не назначен подрядчику
    'assigned',      -- назначен подрядчику (профиль в его папке, blocked); подрядчик вписывает/правит ФИО
    'submitted',     -- ФИО вписано, в составе заявки на согласование
    'applied',       -- админ одобрил, переименован/разблокирован в Sigur
    'blocked',       -- ФИО сменено или отозвано — заблокирован в Sigur до повторного одобрения
    'revoked'        -- окончательно отозван
  ));

-- Поштучный статус согласования (рядом с общим status заявки в contractor_submissions).
ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_submitted';
ALTER TABLE public.contractor_passes
  DROP CONSTRAINT IF EXISTS contractor_passes_approval_status_check;
ALTER TABLE public.contractor_passes
  ADD CONSTRAINT contractor_passes_approval_status_check
  CHECK (approval_status IN ('not_submitted', 'pending', 'approved', 'rejected'));

-- Маппинг approval_status для уже существующих данных.
UPDATE public.contractor_passes
   SET approval_status = 'pending'
 WHERE status = 'submitted';
UPDATE public.contractor_passes
   SET approval_status = 'approved'
 WHERE status = 'applied';

-- Признак активности профиля в Sigur (для мониторинга).
ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

-- Бэкфилл: applied = активен.
UPDATE public.contractor_passes
   SET is_active = true
 WHERE status = 'applied';

-- Индекс для пула.
CREATE INDEX IF NOT EXISTS contractor_passes_in_pool_idx
  ON public.contractor_passes(created_at)
  WHERE status = 'in_pool';

-- Индекс для админских выборок «отправленные / в работе».
CREATE INDEX IF NOT EXISTS contractor_passes_in_flight_idx
  ON public.contractor_passes(org_department_id, status)
  WHERE status IN ('assigned', 'submitted', 'blocked');

-- Гарантия уникальности pass_number в пуле (org_department_id IS NULL).
-- Существующий contractor_passes_unique(org_department_id, pass_number) не
-- покрывает NULL, поэтому добавляем отдельный частичный индекс.
CREATE UNIQUE INDEX IF NOT EXISTS contractor_passes_pool_pass_number_uniq
  ON public.contractor_passes(pass_number)
  WHERE org_department_id IS NULL;

-- =====================================================================
-- 116.3. История владельцев пропуска — contractor_pass_holders.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.contractor_pass_holders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id uuid NOT NULL REFERENCES public.contractor_passes(id) ON DELETE CASCADE,
  holder_name text NOT NULL,
  valid_from date NOT NULL,                  -- дата вступления (вводит подрядчик)
  valid_until date NULL,                     -- NULL для текущего владельца
  changed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  submission_id uuid REFERENCES public.contractor_submissions(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contractor_pass_holders_pass_idx
  ON public.contractor_pass_holders(pass_id, valid_from);

-- Один «открытый» владелец на пропуск.
CREATE UNIQUE INDEX IF NOT EXISTS contractor_pass_holders_current_uniq
  ON public.contractor_pass_holders(pass_id)
  WHERE valid_until IS NULL;

-- Бэкфилл: переносим текущий holder_name из contractor_passes (миграция 105)
-- как первичную строку истории (valid_from = дата создания пропуска).
INSERT INTO public.contractor_pass_holders (
  pass_id, holder_name, valid_from, valid_until, changed_by, submission_id, approved_by, approved_at
)
SELECT
  cp.id,
  cp.holder_name,
  COALESCE(cp.created_at::date, CURRENT_DATE),
  NULL,
  cp.created_by,
  cp.submission_id,
  CASE WHEN cp.status = 'applied' THEN cp.created_by END,
  CASE WHEN cp.status = 'applied' THEN cp.created_at END
FROM public.contractor_passes cp
WHERE cp.holder_name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.contractor_pass_holders h
     WHERE h.pass_id = cp.id AND h.valid_until IS NULL
  );

-- =====================================================================
-- 116.4. История поштучных решений — contractor_submission_decisions.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.contractor_submission_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.contractor_submissions(id) ON DELETE CASCADE,
  pass_id uuid NOT NULL REFERENCES public.contractor_passes(id) ON DELETE CASCADE,
  decision text NOT NULL,
  decided_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT now(),
  reason text NULL,
  access_point_names text[] NULL,  -- snapshot точек доступа при одобрении
  CONSTRAINT contractor_submission_decisions_decision_check
    CHECK (decision IN ('approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS contractor_submission_decisions_pass_idx
  ON public.contractor_submission_decisions(pass_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS contractor_submission_decisions_submission_idx
  ON public.contractor_submission_decisions(submission_id);

-- =====================================================================
-- 116.5. Переименование label страницы.
-- =====================================================================
UPDATE public.access_pages
   SET label = 'Пропуск подрядчика'
 WHERE path = '/admin/contractor-approvals';

NOTIFY pgrst, 'reload schema';

COMMIT;
