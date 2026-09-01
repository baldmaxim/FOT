-- 261: идемпотентный lifecycle сотрудника — версия состояния, durable-операции, метки отсутствия в Sigur.
--
-- Контекст (инцидент 31.08–01.09.2026, Тухтаев 1826): синк Sigur уволил сотрудника по
-- одной постраничной выгрузке (карточка выпала между страницами), а после «Восстановить»
-- уволил снова через 3 минуты — стартовый синк прочитал Sigur до того, как тот отдал перенос.
--
-- lifecycle_revision растёт на КАЖДОМ переходе (увольнение, восстановление, назначение и
-- отмена отложенного увольнения, repair). Синк применяет изменения только по CAS на свежую
-- версию: решение, принятое по устаревшему снимку, становится noop.
--
-- employee_lifecycle_operations — журнал операций «Sigur + PG» с идемпотентными шагами:
-- crash на любом шаге доводится планировщиком по lease, повтор кнопки продолжает ту же
-- операцию. Не более одной pending-операции на сотрудника.
--
-- employee_sigur_absence_marks — первый такт двухтактного auto-fire: увольнение по
-- «карточки нет в Sigur» только после второго независимого 404 в следующем прогоне
-- при неизменной lifecycle_revision.

BEGIN;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS lifecycle_revision integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.employee_lifecycle_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id bigint NOT NULL REFERENCES public.employees(id),
  kind text NOT NULL CHECK (kind IN ('rehire', 'dismiss', 'repair_sigur')),
  status text NOT NULL CHECK (status IN ('pending', 'applied', 'cancelled')),
  -- manual | scheduler | contractor_admin | sigur_archive | sigur_missing | sigur_compensation
  source text NOT NULL,
  -- employees.lifecycle_revision на момент открытия: финализация — CAS по этой версии
  base_revision integer NOT NULL,
  -- persisted payload: повтор детерминирован и не перечитывает текущее состояние сотрудника
  sigur_employee_id integer,
  from_department_id uuid,
  target_department_id uuid NOT NULL,
  target_sigur_department_id integer,
  effective_date date NOT NULL,
  dismissal_date date,
  -- шаги Sigur: какие нужны (решается при открытии) и какие уже выполнены
  sigur_move_required boolean NOT NULL DEFAULT true,
  sigur_access_required boolean NOT NULL DEFAULT true,
  sigur_moved boolean NOT NULL DEFAULT false,
  sigur_access_toggled boolean NOT NULL DEFAULT false,
  sigur_detached boolean NOT NULL DEFAULT false,
  -- lease-протокол: операцию одновременно выполняет ровно один исполнитель
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_lifecycle_operations_pending_uq
  ON public.employee_lifecycle_operations (employee_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS employee_lifecycle_operations_pending_lease_idx
  ON public.employee_lifecycle_operations (lease_expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS employee_lifecycle_operations_employee_applied_idx
  ON public.employee_lifecycle_operations (employee_id, applied_at DESC)
  WHERE status = 'applied';

ALTER TABLE public.employee_dismissal_events
  ADD COLUMN IF NOT EXISTS operation_id uuid REFERENCES public.employee_lifecycle_operations(id);

-- Одно событие истории на операцию: конфликт откатывает транзакцию финализации.
CREATE UNIQUE INDEX IF NOT EXISTS employee_dismissal_events_operation_uq
  ON public.employee_dismissal_events (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.employee_sigur_absence_marks (
  employee_id bigint PRIMARY KEY REFERENCES public.employees(id),
  sigur_employee_id integer NOT NULL,
  lifecycle_revision integer NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  strikes integer NOT NULL DEFAULT 1
);

COMMIT;
