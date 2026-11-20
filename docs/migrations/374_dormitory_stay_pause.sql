-- 374: «Проживание» → «Компенсация аренды»: приостановка и возобновление компенсации.
--
-- Зачем (решения пользователя 20.11.2026). Компенсацию аренды (employee_dormitory_stays вида 'apartment') кадры
-- приостанавливают с даты и потом возобновляют. В расчёте пауза — обычный промежуток между записями: прежняя запись
-- закрывается датой паузы, возобновление — новая запись с даты (дни всех записей месяца складываются, правила —
-- payroll-payslip.rules.ts). Колонки нужны экрану:
--   suspended        — запись закрыта паузой, а не окончанием: приостановленная без возобновления видна в следующих
--                      месяцах («Приостановлена с …»), пока её не возобновят или не завершат (suspended = false);
--   resumed_from_id  — запись создана «Возобновить» из этой приостановленной: цепочка даёт «Начало компенсации» (первая
--                      запись) и даты паузы/возобновления; UNIQUE — у паузы одно возобновление (повтор и параллельный
--                      запрос не создадут вторую запись).
--
-- Деньги: 0 изменений — новые колонки у существующих записей false / NULL.
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (deploy-server.sh migrate, затем backend): бэкенд читает колонки через to_jsonb и без
-- миграции не падает, но пишет их при паузе, возобновлении и правке дат. Повторный запуск безопасен.
-- Номер 374: 373 — 373_staff_month_1c_export_states.sql.

BEGIN;

ALTER TABLE employee_dormitory_stays ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE employee_dormitory_stays
  ADD COLUMN IF NOT EXISTS resumed_from_id INTEGER REFERENCES employee_dormitory_stays(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employee_dormitory_stays_resumed_from
  ON employee_dormitory_stays (resumed_from_id) WHERE resumed_from_id IS NOT NULL;

COMMENT ON COLUMN employee_dormitory_stays.suspended IS
  'Компенсация аренды закрыта паузой (миграция 374), а не окончанием; только у вида apartment с датой выезда.';
COMMENT ON COLUMN employee_dormitory_stays.resumed_from_id IS
  'Компенсация возобновлена из этой приостановленной записи (миграция 374); у паузы одно возобновление.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_dormitory_stay_suspended') THEN
    ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_suspended
      CHECK (NOT suspended OR (kind = 'apartment' AND check_out IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_dormitory_stay_resumed_from') THEN
    ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_resumed_from
      CHECK (resumed_from_id IS NULL OR (kind = 'apartment' AND resumed_from_id <> id));
  END IF;
END $$;

COMMIT;
