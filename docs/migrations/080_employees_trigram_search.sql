-- 080_employees_trigram_search.sql
-- Триграммный индекс для быстрого ILIKE-поиска сотрудников
-- (используется при привязке карты через считыватель и в других search-формах).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_employees_full_name_trgm
  ON employees USING gin (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_employees_tab_number_trgm
  ON employees USING gin (tab_number gin_trgm_ops)
  WHERE tab_number IS NOT NULL;
