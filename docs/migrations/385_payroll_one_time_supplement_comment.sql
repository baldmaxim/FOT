-- 385: Разовая доплата — комментарий.
--
-- Зачем. В «Справочник → Доплата» к разовой доплате (миграция 315) пишут комментарий — пояснение сверх основания
-- из списка. Его видно в «Доплате за месяц» под основанием и в xlsx; правка — в окне ✎ и в аудите доплаты.
--
-- В расчёте ФОТ не участвует. Существующие строки получают NULL — суммы, основания и файлы не меняются.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый бэкенд пишет и читает колонку. Прежний бэкенд колонку не знает и не
-- пишет — с ним миграция безопасна. Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_one_time_supplements
  ADD COLUMN IF NOT EXISTS comment TEXT;

ALTER TABLE payroll_one_time_supplements DROP CONSTRAINT IF EXISTS payroll_one_time_supplement_comment;
ALTER TABLE payroll_one_time_supplements ADD CONSTRAINT payroll_one_time_supplement_comment CHECK (
  comment IS NULL OR (comment = btrim(comment) AND char_length(comment) BETWEEN 1 AND 500));

COMMENT ON COLUMN payroll_one_time_supplements.comment IS
  'Комментарий разовой доплаты (до 500 символов, без пробелов по краям); NULL — без комментария.';

COMMIT;
