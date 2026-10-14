-- 308: Журнал выгрузок «Единый файл для 1С» из «Табели HR» (вкладки «По отделам» и «По объектам»).
--
-- Зачем. Файл грузят в 1С/ЗУП, и там бывает, что пропал сотрудник или не то число часов — а на
-- каком этапе, непонятно. Журнал отвечает на три вопроса:
--   1. Есть ли сотрудник в файле и с какими значениями (timesheet_1c_export_log_rows — значения
--      ровно как в ячейках) → есть и верно — потеря при загрузке в 1С.
--   2. Если нет — на каком этапе отбора ФОТ его отсеял (timesheet_1c_export_log_candidates.drop_stage).
--   3. Нет и среди кандидатов — не входил в состав выбранных отделов/объектов.
-- Сам xlsx не храним: значения строк + sha256 файла (сверить, тот ли файл загрузили).
--
-- Пишется строго: запись не удалась — файл не отдаётся (иначе в журнале дыры там, где ищем потерю).
-- employee_id без FK — снимок не должен зависеть от удаления сотрудника.
-- Автор — политика author из 284/285: NOT NULL + ON DELETE SET DEFAULT на надгробие.
--
-- drop_stage (NULL — попал в файл), порядок этапов:
--   «По отделам»:  archived → fired → excluded_from_timesheet (допуск членства)
--                  → not_in_membership (страховка: допущен по флагам, но в составе выгрузки нет)
--                  → transfer_out_of_scope (перевод внутри периода, дней в выбранных отделах нет)
--                  → fired_or_archived (фильтр статуса при загрузке данных)
--                  → zero_activity (ни одного сигнала за период) → no_row (данные есть, строки нет)
--   «По объектам»: archived_or_excluded (группировка по отделам) → department_filter
--                  → fired_or_archived → zero_activity → no_row
--
-- Разбор потери — примеры:
--   -- что уходило в файлы по сотруднику за месяц
--   SELECT l.created_at, p.full_name AS who, l.source, l.period_start, l.period_end,
--          r.excel_row, r.department_name, r.object_address, r.days, r.total_hours, r.worked_days
--     FROM timesheet_1c_export_log_rows r
--     JOIN timesheet_1c_export_log l ON l.id = r.export_id
--     LEFT JOIN user_profiles p ON p.id = l.user_id
--    WHERE r.employee_id = 1234 AND l.month = DATE '2026-10-01'
--    ORDER BY l.created_at, r.excel_row;
--   -- на каком этапе отсеян
--   SELECT l.created_at, l.source, c.department_id, c.sources, c.drop_stage
--     FROM timesheet_1c_export_log_candidates c
--     JOIN timesheet_1c_export_log l ON l.id = c.export_id
--    WHERE c.employee_id = 1234 AND l.month = DATE '2026-10-01'
--    ORDER BY l.created_at;
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (без таблиц выгрузка отвечает 500). Прежний бэкенд с ней работает.
-- Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS public.timesheet_1c_export_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id               UUID NOT NULL DEFAULT '00000000-0000-0000-0000-00000000dead'::uuid
                        REFERENCES public.user_profiles(id) ON DELETE SET DEFAULT,
  source                TEXT NOT NULL,
  month                 DATE NOT NULL,
  period_start          DATE NOT NULL,
  period_end            DATE NOT NULL,
  department_ids        UUID[] NOT NULL DEFAULT '{}',
  department_filter_ids UUID[] NOT NULL DEFAULT '{}',
  object_ids            UUID[] NOT NULL DEFAULT '{}',
  file_name             TEXT NOT NULL,
  file_sha256           TEXT NOT NULL,
  file_bytes            INTEGER NOT NULL,
  row_count             INTEGER NOT NULL,
  employee_count        INTEGER NOT NULL,
  candidate_count       INTEGER NOT NULL,
  ip_address            TEXT,
  user_agent            TEXT,

  CONSTRAINT timesheet_1c_export_log_source CHECK (source IN ('hr_departments', 'hr_objects')),
  CONSTRAINT timesheet_1c_export_log_month CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT timesheet_1c_export_log_period CHECK (
    period_start <= period_end
    AND date_trunc('month', period_start)::date = month
    AND date_trunc('month', period_end)::date = month
  ),
  CONSTRAINT timesheet_1c_export_log_sha256 CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT timesheet_1c_export_log_counts CHECK (
    file_bytes >= 0 AND row_count >= 0 AND employee_count >= 0 AND candidate_count >= 0
  )
);

CREATE INDEX IF NOT EXISTS timesheet_1c_export_log_source_month_idx
  ON public.timesheet_1c_export_log (source, month, created_at DESC);

COMMENT ON TABLE public.timesheet_1c_export_log IS
  'Выгрузки «Единый файл для 1С» из «Табели HR»: кто, когда, период, выбор, отпечаток файла.';

CREATE TABLE IF NOT EXISTS public.timesheet_1c_export_log_rows (
  export_id       UUID NOT NULL REFERENCES public.timesheet_1c_export_log(id) ON DELETE CASCADE,
  excel_row       INTEGER NOT NULL,
  employee_id     INTEGER NOT NULL,
  full_name       TEXT NOT NULL,
  department_id   UUID,
  department_name TEXT NOT NULL,
  object_id       UUID,
  object_address  TEXT NOT NULL,
  manager_name    TEXT NOT NULL,
  position        TEXT NOT NULL,
  days            JSONB NOT NULL,
  total_hours     NUMERIC,
  worked_days     INTEGER,

  PRIMARY KEY (export_id, excel_row),
  CONSTRAINT timesheet_1c_export_log_rows_excel_row CHECK (excel_row >= 4),
  CONSTRAINT timesheet_1c_export_log_rows_days CHECK (jsonb_typeof(days) = 'object'),
  CONSTRAINT timesheet_1c_export_log_rows_totals CHECK (
    (total_hours IS NULL OR total_hours >= 0) AND (worked_days IS NULL OR worked_days >= 0)
  )
);

CREATE INDEX IF NOT EXISTS timesheet_1c_export_log_rows_employee_idx
  ON public.timesheet_1c_export_log_rows (employee_id, export_id);

COMMENT ON TABLE public.timesheet_1c_export_log_rows IS
  'Строки выгрузки «Единый файл для 1С»: значения ровно как в ячейках (пустая ячейка — NULL / нет ключа дня).';

CREATE TABLE IF NOT EXISTS public.timesheet_1c_export_log_candidates (
  export_id     UUID NOT NULL REFERENCES public.timesheet_1c_export_log(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL,
  department_id UUID,
  sources       TEXT[] NOT NULL,
  drop_stage    TEXT,

  PRIMARY KEY (export_id, employee_id),
  CONSTRAINT timesheet_1c_export_log_candidates_sources CHECK (
    sources <@ ARRAY['assignment', 'snapshot', 'dismissal', 'membership',
                     'object_events', 'object_pinned', 'department_manager']::text[]
  ),
  CONSTRAINT timesheet_1c_export_log_candidates_stage CHECK (
    drop_stage IS NULL OR drop_stage IN (
      'archived', 'fired', 'excluded_from_timesheet', 'not_in_membership', 'transfer_out_of_scope',
      'archived_or_excluded', 'department_filter', 'fired_or_archived', 'zero_activity', 'no_row'
    )
  )
);

CREATE INDEX IF NOT EXISTS timesheet_1c_export_log_candidates_employee_idx
  ON public.timesheet_1c_export_log_candidates (employee_id, export_id);

COMMENT ON TABLE public.timesheet_1c_export_log_candidates IS
  'Кандидаты выгрузки «Единый файл для 1С» и этап, на котором ФОТ отсеял каждого (NULL — в файле).';

REVOKE ALL ON TABLE public.timesheet_1c_export_log FROM PUBLIC;
REVOKE ALL ON TABLE public.timesheet_1c_export_log_rows FROM PUBLIC;
REVOKE ALL ON TABLE public.timesheet_1c_export_log_candidates FROM PUBLIC;

COMMIT;
