-- 339: Зарплата — проживание по дням: даты отсутствий в основе расчёта, включатель авто-доплаты за общежитие.
--
-- Зачем (решения пользователя 30.10.2026). 1С платит «Компенсацию проживания» ставкой за день, ФОТ брал сумму записи
-- за весь месяц. Теперь в расчёте ФОТ:
--   «Квартира» — ставка ₽/день (630) × календарные дни проживания в пределах работы, кроме дней отпуска любого вида и
--     больничного; текущий месяц — до вчера МСК (как живой табель);
--   «Доплата за общежитие» — автоматически членам бригад: ставка (160) × дни, отработанные в бригаде, кроме дней
--     в общежитии и в квартире; ручной список payroll_dormitory_allowances больше не нужен.
--
-- timesheet_version_payroll_basis.absence_dates — даты отсутствий: {"vacation": [...], "sick": [...], ...}, те же
--   статусы и отсечка, что у счётчиков absence_days. NULL — основа записана до 339 (только счётчики);
--   сентябрь–октябрь 2026 дозаполняет scripts/backfill-payroll-basis-absence-dates.ts новой revision.
-- payroll_switches — включатели правил расчёта с месяца. dormitory_allowance_auto ставит скрипт загрузки списка
--   «Общежития» в той же транзакции, что и сам список: пока ключа нет, авто-доплаты нет (иначе 160 получили бы все
--   бригады, включая живущих в общежитии).
--
-- Номер 339: 338 — 338_payroll_paid_extra_accruals_sep.sql (статьи «Оплачено»).
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (новый бэкенд пишет absence_dates и читает payroll_switches). Прежний бэкенд колонку и
-- таблицу не видит и не ломается. Повторный запуск безопасен.

BEGIN;

ALTER TABLE timesheet_version_payroll_basis ADD COLUMN IF NOT EXISTS absence_dates JSONB;

COMMENT ON COLUMN timesheet_version_payroll_basis.absence_dates IS
  'Даты отсутствий по статусам ({"vacation": ["2026-09-10", ...], "sick": [...], "educational_leave": [...], "unpaid": [...]}) — '
  'для дней «Квартиры» (миграция 339). NULL — основа до 339, есть только счётчики absence_days.';

CREATE TABLE IF NOT EXISTS payroll_switches (
  key         TEXT PRIMARY KEY CHECK (key IN ('dormitory_allowance_auto')),
  active_from DATE NOT NULL CHECK (active_from = date_trunc('month', active_from)::date),
  set_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE payroll_switches IS
  'Включатели правил расчёта «К выплате (ФОТ)» с месяца active_from (миграция 339). dormitory_allowance_auto — '
  'доплата за общежитие членам бригад по дням (ставка dormitory_allowance), кроме дней в общежитии и квартире.';

-- Комментарии — только если таблицы есть (на проде есть; в тестовых базах их может не быть).
DO $$
BEGIN
  IF to_regclass('public.employee_dormitory_stays') IS NOT NULL THEN
    COMMENT ON COLUMN employee_dormitory_stays.amount IS
      'Только у квартиры: ставка доплаты за проживание, ₽ в день (миграция 339; до неё — ₽/мес, квартир тогда не было). '
      'Расчёт: ставка × календарные дни проживания без отпуска и больничного.';
  END IF;
  IF to_regclass('public.payroll_dormitory_allowances') IS NOT NULL THEN
    COMMENT ON TABLE payroll_dormitory_allowances IS
      'Ручная «Доплата за общежитие» (миграция 317). С миграции 339 не используется: доплата считается автоматически '
      '(payroll_switches.dormitory_allowance_auto). Удалить отдельной миграцией.';
  END IF;
END $$;

COMMIT;
