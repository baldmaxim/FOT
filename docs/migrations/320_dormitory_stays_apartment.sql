-- 320: «Проживание» — кроме общежития, квартира. Квартира и есть «Доплата за проживание» «Зарплаты».
--
-- Строка employee_dormitory_stays теперь бывает двух видов (kind):
--   dormitory — общежитие компании: адрес обязателен, суммы нет (как в 314);
--   apartment — живёт в квартире: сумма ₽/мес обязательна (по умолчанию в окне — ставка housing, 630),
--               адрес необязателен.
-- Одни и те же записи ведут кадры («Управление кадрами» → «Проживание») и «Зарплата» («Справочник» →
-- «Ставки» → «Проживание», таблица «Доплата за проживание»). Раньше доплата за проживание жила в версиях
-- условий оплаты (payroll_compensation_terms.housing_compensation, «Действует с», без оклада не записать):
-- с этой миграции её источник — квартиры; колонка остаётся, бэкенд её больше не читает и не пишет
-- (удалить отдельной миграцией). На момент миграции на проде housing_compensation > 0 нет — переносить нечего;
-- если появились — миграция останавливается, чтобы не потерять суммы.
--
-- EXCLUDE прежний и через оба вида: в один день человек живёт в одном месте.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Прежний бэкенд с ней работает (пишет без kind — общежитие). Повторный запуск безопасен.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_compensation_terms WHERE housing_compensation > 0) THEN
    RAISE EXCEPTION 'Есть доплата за проживание в условиях оплаты (housing_compensation > 0) — перенесите её в квартиры до миграции 320';
  END IF;
END $$;

ALTER TABLE employee_dormitory_stays ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dormitory';
ALTER TABLE employee_dormitory_stays ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2);
ALTER TABLE employee_dormitory_stays ALTER COLUMN address DROP NOT NULL;

ALTER TABLE employee_dormitory_stays DROP CONSTRAINT IF EXISTS employee_dormitory_stay_kind;
ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_kind
  CHECK (kind IN ('dormitory', 'apartment'));

ALTER TABLE employee_dormitory_stays DROP CONSTRAINT IF EXISTS employee_dormitory_stay_amount;
-- amount IS NOT NULL явно: «NULL > 0» даёт NULL, и CHECK пропустил бы квартиру без суммы.
ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_amount
  CHECK ((kind = 'dormitory' AND amount IS NULL) OR (kind = 'apartment' AND amount IS NOT NULL AND amount > 0));

-- Адрес: у общежития обязателен; у квартиры может не быть, но если есть — непустой и не длиннее 200.
ALTER TABLE employee_dormitory_stays DROP CONSTRAINT IF EXISTS employee_dormitory_stay_address;
ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_address
  CHECK (
    (address IS NULL AND kind = 'apartment')
    OR (address IS NOT NULL AND btrim(address) <> '' AND length(address) <= 200)
  );

-- Таблица «Доплата за проживание» выбирает квартиры.
CREATE INDEX IF NOT EXISTS employee_dormitory_stays_apartments
  ON employee_dormitory_stays (employee_id, check_in) WHERE kind = 'apartment';

COMMENT ON TABLE employee_dormitory_stays IS
  'Проживание сотрудников («Управление кадрами» → «Проживание»): общежитие (адрес) или квартира (сумма доплаты за проживание ₽/мес, адрес необязателен); въезд, выезд; периоды одного сотрудника не пересекаются. Квартиры — «Доплата за проживание» «Зарплаты». См. миграции 314, 320.';
COMMENT ON COLUMN employee_dormitory_stays.kind IS
  'dormitory — общежитие компании, apartment — квартира (доплата за проживание). См. миграцию 320.';
COMMENT ON COLUMN employee_dormitory_stays.amount IS
  'Только у квартиры: доплата за проживание, ₽/мес. См. миграцию 320.';
COMMENT ON COLUMN payroll_compensation_terms.housing_compensation IS
  'Не используется с миграции 320: доплата за проживание — квартиры в employee_dormitory_stays. Удалить отдельной миграцией.';

COMMIT;
