-- 311_timesheet_correction_leaves.sql
-- Отпуск, поставленный корректировкой табеля, — во вкладке кадров «Заявления → Отпуска».
--
-- Руководитель может поставить «Отпуск» / «За свой счёт» / «Учебный отпуск» корректировкой
-- (attendance_adjustments, source_type = 'manual'). Заявления при этом нет, и кадры такой
-- отпуск не видели — в 1С он не оформлялся (Дульянинов, октябрь 2026).
--
-- Карточка во вкладке НЕ хранится: она вычисляется из табеля (серия ручных отпускных дней
-- подряд у одного сотрудника, одного типа, одного автора и с одной причиной). Здесь —
-- только то, чего в табеле нет:
--   timesheet_correction_leave_days       — состояние кадров по дню: о дне сообщили, кадры
--                                           ознакомились (и с каким типом/файлами), день
--                                           сняли из табеля после ознакомления;
--   timesheet_correction_leave_rejections — история отказов кадров (сами дни удаляются);
--   timesheet_correction_leave_reconcile  — одна строка: первый прогон сверщика выполнен.
--
-- adjustment_id в состоянии — БЕЗ внешнего ключа: строка состояния должна пережить удаление
-- дня из табеля, иначе ON DELETE CASCADE стёр бы и сам факт ознакомления, и кадры не узнали
-- бы, что ознакомленный отпуск сняли.
--
-- Авторские ссылки на user_profiles — nullable, ON DELETE SET NULL без DEFAULT (политика
-- author, миграции 284/285, стережёт npm run audit:user-fk).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый бэкенд без таблиц не покажет вкладку, а сверщик будет
-- падать на каждом тике. Прежний бэкенд таблиц не замечает. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS public.timesheet_correction_leave_days (
  adjustment_id   bigint PRIMARY KEY,
  employee_id     integer NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  work_date       date NOT NULL,
  leave_status    text NOT NULL CHECK (leave_status IN ('vacation', 'unpaid', 'educational_leave')),
  files_sig       text NOT NULL DEFAULT '',
  author_id       uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  notified_at     timestamptz,
  acked_at        timestamptz,
  acked_by        uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  acked_status    text CHECK (acked_status IN ('vacation', 'unpaid', 'educational_leave')),
  acked_files_sig text,
  removed_at      timestamptz,
  removed_kind    text CHECK (removed_kind IN ('deleted', 'status_changed')),
  removed_seen_at timestamptz,
  removed_seen_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  -- Отметка «Ознакомлен» — снимок версии дня: все три поля вместе или ни одного.
  CONSTRAINT timesheet_correction_leave_days_ack_complete CHECK (
    (acked_at IS NULL AND acked_status IS NULL AND acked_files_sig IS NULL)
    OR (acked_at IS NOT NULL AND acked_status IS NOT NULL AND acked_files_sig IS NOT NULL)
  ),
  CONSTRAINT timesheet_correction_leave_days_removed_complete CHECK (
    (removed_at IS NULL) = (removed_kind IS NULL)
  ),
  CONSTRAINT timesheet_correction_leave_days_removed_seen CHECK (
    removed_seen_at IS NULL OR removed_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_tcl_days_employee_date
  ON public.timesheet_correction_leave_days (employee_id, work_date);

CREATE INDEX IF NOT EXISTS idx_tcl_days_removed_unseen
  ON public.timesheet_correction_leave_days (employee_id, work_date)
  WHERE removed_at IS NOT NULL AND removed_seen_at IS NULL;

COMMENT ON TABLE public.timesheet_correction_leave_days IS
  'Отпуск корректировкой табеля: состояние кадров по дню (сообщили / ознакомились / сняли после ознакомления). Карточки вычисляются из attendance_adjustments.';
COMMENT ON COLUMN public.timesheet_correction_leave_days.adjustment_id IS
  'attendance_adjustments.id без FK: строка переживает удаление дня, чтобы кадры узнали о снятии.';
COMMENT ON COLUMN public.timesheet_correction_leave_days.files_sig IS
  'Отсортированные id документов дня через запятую — часть версии дня наряду с типом.';

CREATE TABLE IF NOT EXISTS public.timesheet_correction_leave_rejections (
  id            bigserial PRIMARY KEY,
  employee_id   integer NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_status  text NOT NULL CHECK (leave_status IN ('vacation', 'unpaid', 'educational_leave')),
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  days          date[] NOT NULL,
  reason        text,
  author_id     uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  rejected_by   uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  rejected_at   timestamptz NOT NULL DEFAULT now(),
  reject_reason text NOT NULL,
  CONSTRAINT timesheet_correction_leave_rejections_days CHECK (cardinality(days) > 0),
  CONSTRAINT timesheet_correction_leave_rejections_range CHECK (end_date >= start_date),
  CONSTRAINT timesheet_correction_leave_rejections_reason CHECK (char_length(reject_reason) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_tcl_rejections_rejected_at
  ON public.timesheet_correction_leave_rejections (rejected_at DESC);

COMMENT ON TABLE public.timesheet_correction_leave_rejections IS
  'Отказы кадров по отпускам, поставленным корректировкой: дни удалены из табеля, здесь — что и почему.';

-- Первый прогон сверщика засевает уже существующие отпуска без уведомлений (иначе кадры
-- получили бы по колокольчику на каждую октябрьскую карточку разом).
CREATE TABLE IF NOT EXISTS public.timesheet_correction_leave_reconcile (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  seeded_at timestamptz
);
INSERT INTO public.timesheet_correction_leave_reconcile (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Выборка видимых дней (сверщик раз в 20 с) идёт по ручным отпускным строкам начиная с даты —
-- частичный индекс под неё.
CREATE INDEX IF NOT EXISTS idx_attendance_adjustments_manual_leave
  ON public.attendance_adjustments (work_date, employee_id)
  WHERE source_type = 'manual' AND status IN ('vacation', 'unpaid', 'educational_leave');

COMMIT;
