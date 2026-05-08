-- 085: Sigur event failures (PASS_DENY, READER_ERROR, ...)
--
-- Отдельная таблица для «ошибочных» событий Sigur (отказ в доступе, таймауты и т.п.).
-- НЕ участвует в skud_daily_summary / fact_hours / presence — служит только источником
-- для UI («Ошибочные события» в SigurRawDataPage, бейджи в модалке табеля и карточке
-- сотрудника). Поэтому существующие потребители skud_events править не нужно.

CREATE TABLE IF NOT EXISTS public.skud_event_failures (
  id              BIGSERIAL,
  employee_id     INTEGER REFERENCES public.employees(id) ON DELETE SET NULL,
  physical_person TEXT,
  card_number     TEXT,
  event_date      DATE NOT NULL,
  event_time      TIME NOT NULL,
  event_at        TIMESTAMPTZ NOT NULL,
  access_point    TEXT,
  direction       TEXT CHECK (direction IN ('entry', 'exit') OR direction IS NULL),
  failure_type    TEXT NOT NULL,                  -- 'PASS_DENY' | 'READER_ERROR' | ...
  failure_type_id INTEGER,                        -- numeric id из EVENT_TYPE_ID_MAP, если есть
  reason          TEXT,                           -- description / reason из Sigur
  raw_event_id    BIGINT,                         -- id события в Sigur (для трассировки)
  dedup_hash      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, event_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_skud_event_failures_dedup
  ON public.skud_event_failures (dedup_hash, event_date);

CREATE INDEX IF NOT EXISTS idx_skud_event_failures_employee_date
  ON public.skud_event_failures (employee_id, event_date DESC, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_skud_event_failures_date_type
  ON public.skud_event_failures (event_date DESC, failure_type);

CREATE INDEX IF NOT EXISTS idx_skud_event_failures_event_at
  ON public.skud_event_failures (event_at DESC);

-- Закрываем PostgREST: бэкенд ходит через service role, RLS его не касается.
-- Аналогично 034_lock_skud_events_from_postgrest.sql.
ALTER TABLE public.skud_event_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_event_failures FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_event_failures FROM anon, authenticated;
