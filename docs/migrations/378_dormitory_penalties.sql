-- 378: «Проживание» → «Общежитие» → «История взысканий»: отдельный список сотрудников со взысканиями.
--
-- Зачем (решения пользователя 24.11.2026). Перед заселением в общежитие кадрам нужно видеть, что у человека были
-- взыскания (штрафы, нарушения) — тогда заселять не нужно. Список ведут сами: «Добавить» в «Истории взысканий»
-- (сотрудник, дата, информация), позже его загрузят скриптом (source = 'import'). С «Удержаниями» «Зарплаты» список
-- не связан (решение пользователя). Окно «Заселить» только предупреждает — заселить можно. Рядом в «Истории
-- взысканий» показываются действующие записи «Чёрного списка» пропусков (person_blacklist, миграция 273) — их
-- ведут в «Системе», здесь они только на чтение.
--
-- Запись: сотрудник (карточка, в том числе уволенного), дата взыскания и/или информация — хотя бы одно из двух
-- (CHECK: пустую запись не создаст и скрипт загрузки в обход проверки API). Колонок-авторов нет: кто добавил и
-- правил — в audit_logs (DORMITORY_PENALTY_ADDED/UPDATED/DELETED); ссылок на пользователя нет — политика FK на
-- пользователя (284/285, audit:user-fk) не затрагивается. Карточку не удаляют (увольнение — статус); если удалят,
-- запись уходит вместе с ней, как проживания (314).
--
-- Деньги: 0 изменений. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (deploy-server.sh migrate, затем backend): прежний бэкенд таблицу
-- не читает. Повторный запуск безопасен. Номер 378: 377 — 377_dormitory_directory.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS dormitory_penalties (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  penalty_date DATE,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dormitory_penalty_note_length CHECK (note IS NULL OR length(note) <= 1000),
  CONSTRAINT dormitory_penalty_source CHECK (source IN ('manual', 'import')),
  CONSTRAINT dormitory_penalty_not_empty CHECK (penalty_date IS NOT NULL OR NULLIF(btrim(note), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS dormitory_penalties_employee_idx ON dormitory_penalties (employee_id);

COMMIT;
