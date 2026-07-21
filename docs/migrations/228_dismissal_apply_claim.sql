-- 228: Lease (claim) для планировщика увольнений.
-- Увольнение с датой «сегодня» больше не применяется сразу: сотрудник дорабатывает
-- последний рабочий день, а перевод в «Уволенные» + блокировка карт Sigur выполняются
-- планировщиком после 23:00 МСК. Пока применение не началось, отмена разрешена —
-- колонка служит атомарным маркером «применение захвачено» (в т.ч. между инстансами бэка).

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS dismissal_apply_started_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN employees.dismissal_apply_started_at IS
  'Lease планировщика увольнений: момент захвата записи для применения. NULL = применение не начато, отмена разрешена. Просроченный lease (>30 мин) перезахватывается.';

-- Индекс не нужен: idx_employees_dismissal_pending (миграция 113) уже покрывает
-- (dismissal_date) WHERE employment_status='active' AND dismissal_date IS NOT NULL.
