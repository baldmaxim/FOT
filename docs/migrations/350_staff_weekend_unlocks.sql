-- 350: «Управление кадрами» → «Выходные»: какие подачи табеля открыла кнопка отдела.
--
-- Кнопка «Открыть табель» снимает замок сразу с нескольких подач (табель отдела и личные табели руководителей).
-- Кнопка «Закрыть табель» обязана закрыть только их, а не подачу, которую кто-то открыл вручную в разделе «Табель».
--
-- Запись действует, пока unlocked_at совпадает с подачей: закрыли и снова открыли в «Табеле» — значение другое,
-- и подача уже не считается открытой вкладкой. openPeriod и closePeriod этой таблицы не касаются.
-- Записи не удаляются: operation_id делает повтор запроса безопасным.
-- Автора нет: он в timesheet_approvals.unlocked_by и аудите, поэтому политика FK на пользователя не затрагивается.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Прежний бэкенд с ней работает. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS public.staff_weekend_unlocks (
  operation_id UUID NOT NULL,
  branch_id    UUID NOT NULL,
  period_start DATE NOT NULL,
  approval_id  BIGINT NOT NULL REFERENCES public.timesheet_approvals(id) ON DELETE CASCADE,
  unlocked_at  TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, approval_id)
);

CREATE INDEX IF NOT EXISTS staff_weekend_unlocks_branch_period_idx
  ON public.staff_weekend_unlocks (branch_id, period_start);

CREATE INDEX IF NOT EXISTS staff_weekend_unlocks_approval_idx
  ON public.staff_weekend_unlocks (approval_id);

COMMIT;
