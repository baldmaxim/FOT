-- 313: Зарплата — ставка «Проживание общежития» с машинным кодом («Расчёты» → «Справочник» → «Ставки»).
--
-- Зачем. Формы добавления в «Ставках» больше нет: ставка одна — «Проживание общежития», у неё кнопка
-- с таблицей проживающих (миграция 314). Привязка — по коду, а не по названию: code = 'dormitory'.
-- Ставку с кодом сервер не даёт удалить и переименовать, значение меняется как раньше.
--
-- Данные. Исходная строка ищется по названию без учёта регистра и пробелов по краям (как уникальный
-- индекс 306), не по id. На проде она есть (630,00) — проставляется только code, название и значение
-- не меняются, строк не удаляется. Строки нет (чистая БД) — создаётся без значения.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Прежний бэкенд с ней работает. Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payroll_rates_code_uniq
  ON payroll_rates (code) WHERE code IS NOT NULL;

UPDATE payroll_rates
   SET code = 'dormitory'
 WHERE lower(btrim(name)) = 'проживание общежития'
   AND code IS NULL
   AND NOT EXISTS (SELECT 1 FROM payroll_rates WHERE code = 'dormitory');

INSERT INTO payroll_rates (name, code)
SELECT 'Проживание общежития', 'dormitory'
 WHERE NOT EXISTS (SELECT 1 FROM payroll_rates WHERE code = 'dormitory');

COMMENT ON COLUMN payroll_rates.code IS
  'Машинный код ставки, к которой привязан функционал (dormitory — «Проживание общежития»); такую ставку не удалить и не переименовать.';

COMMIT;
