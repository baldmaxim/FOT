-- 269: снимок полномочий, снятых увольнением — чтобы восстановление их вернуло.
-- Применять ДО деплоя бэкенда.
--
-- До этой миграции увольнение необратимо: runDismiss гасит employee_department_access
-- (и, начиная с этого релиза, employee_direct_reports), а runRehire возвращает только
-- один технический доступ. Ошибочное увольнение — например автоматическое из Sigur —
-- стоило человеку всех отделов и подчинённых, восстановить их можно было лишь руками
-- и по памяти.
--
-- Снимок пишется в той же CAS-транзакции, что и смена статуса: если увольнение не
-- применилось (STATE_CHANGED, конкурентный rehire), снимка тоже не будет. Восстановление
-- читает строки своей dismiss-операции и возвращает ровно их.
--
-- Ничего не удаляется: сами строки доступов и связей остаются на месте с is_active=false,
-- снимок лишь фиксирует, какие из них погасило конкретное увольнение.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_lifecycle_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- увольнение, снявшее полномочие; ON DELETE CASCADE — журнал операций владеет снимком
  operation_id uuid NOT NULL REFERENCES public.employee_lifecycle_operations(id) ON DELETE CASCADE,
  employee_id bigint NOT NULL REFERENCES public.employees(id),
  -- department_access — строка employee_department_access уволенного;
  -- direct_report — строка employee_direct_reports, где уволенный был руководителем
  kind text NOT NULL CHECK (kind IN ('department_access', 'direct_report')),
  -- id снятой строки в её таблице
  row_id text NOT NULL,
  -- поля строки на момент снятия: восстановление сверяет их с текущим состоянием
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Повтор операции по lease не должен плодить дубли снимка.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lifecycle_revocation_row
  ON public.employee_lifecycle_revocations (operation_id, kind, row_id);

-- Основной путь чтения: восстановление тянет снимок своей dismiss-операции.
CREATE INDEX IF NOT EXISTS idx_lifecycle_revocation_operation
  ON public.employee_lifecycle_revocations (operation_id, kind);

-- Диагностика «что снимали у этого сотрудника».
CREATE INDEX IF NOT EXISTS idx_lifecycle_revocation_employee
  ON public.employee_lifecycle_revocations (employee_id, created_at DESC);

COMMIT;
