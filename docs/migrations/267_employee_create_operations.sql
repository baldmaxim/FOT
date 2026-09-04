-- 267: идемпотентное создание сотрудника (Sigur + PG).
-- Применять ДО деплоя бэкенда.
--
-- POST /api/employees сначала создаёт карточку в Sigur, затем пишет строку в employees.
-- До этой миграции sigur_employee_id возвращался вызывающему только после
-- syncSigurEmployeeBlockedState и контрольного GET: падение в этом окне теряло уже
-- созданную карточку Sigur, а повтор кнопки создавал дубль.
--
-- Журнал операций делает повтор безопасным: claim по operation_id (ON CONFLICT DO
-- NOTHING) отсекает параллельные запросы, sigur_employee_id фиксируется сразу после
-- ответа Sigur, локальная часть доводится в одной транзакции. Дополнительная страховка
-- на случай падения ДО записи id — маркер FOT-OP:<operation_id> в description карточки
-- Sigur: перед повторным созданием ищем карточку по маркеру.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_create_operations (
  operation_id uuid PRIMARY KEY,
  requested_by uuid,
  -- хэш нормализованного тела запроса: тот же ключ с другим телом — ошибка, не повтор
  payload_hash text NOT NULL,
  -- claimed → sigur_created → employee_created → done; failed доводится повтором
  status text NOT NULL CHECK (status IN ('claimed', 'sigur_created', 'employee_created', 'done', 'failed')),
  sigur_employee_id integer,
  employee_id bigint,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_create_operations_sigur_idx
  ON public.employee_create_operations (sigur_employee_id)
  WHERE sigur_employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS employee_create_operations_status_idx
  ON public.employee_create_operations (status, created_at DESC);

COMMENT ON TABLE public.employee_create_operations IS
  'Журнал идемпотентного создания сотрудника: один operation_id — ровно один сотрудник в Sigur и в employees.';

COMMIT;
