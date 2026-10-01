-- 293: Условия оплаты — плановая доплата сотрудника.
--
-- Зачем. Карточка «Зарплата → Подробно» показывает раздел «Плановые доплаты»: сумма ₽/мес
-- и период «с — по». У сотрудника одна доплата: правка заменяет её, очистка — снимает.
-- Каждое изменение видно в «Истории изменений условий оплаты».
--
-- Ключевые решения:
--   * Отдельная таблица, а не колонки payroll_compensation_terms: у доплаты свой период,
--     не связанный с «Действует с» условий. Доплата задним числом не попала бы в строку
--     условий, действующую в тот период.
--   * Журнал версий вместо перезаписи. Текущая доплата — последняя строка сотрудника
--     (по id), строка с amount NULL — «снята». История — все строки.
--   * Новая версия пишется только при отличии от последней — повторное сохранение
--     карточки без правки истории не засоряет.
--
-- Сумма ₽/мес. В расчёте зарплаты пока НЕ участвует — справочно до этапа расчёта.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS payroll_planned_supplements (
  id          BIGSERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  amount      NUMERIC(12,2),
  date_from   DATE,
  date_to     DATE,
  -- Автор в колонке с NULL: ON DELETE SET NULL без DEFAULT (политика миграции 285).
  created_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payroll_supplement_state CHECK (
       (amount IS NULL AND date_from IS NULL AND date_to IS NULL)
    OR (amount > 0 AND date_from IS NOT NULL AND date_to IS NOT NULL AND date_to >= date_from))
);

CREATE INDEX IF NOT EXISTS idx_payroll_supplements_employee
  ON payroll_planned_supplements (employee_id, id DESC);

COMMENT ON TABLE payroll_planned_supplements IS
  'Плановая доплата сотрудника — журнал версий. Текущая — последняя строка сотрудника по id; '
  'amount NULL — доплата снята. В расчёте зарплаты пока не участвует.';
COMMENT ON COLUMN payroll_planned_supplements.amount IS
  'Доплата, ₽/мес, на период date_from — date_to включительно. NULL — доплата снята.';

REVOKE ALL ON TABLE public.payroll_planned_supplements FROM PUBLIC;

COMMIT;
