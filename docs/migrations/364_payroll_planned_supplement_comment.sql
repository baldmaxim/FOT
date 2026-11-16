-- 364: Плановая доплата — комментарий периода.
--
-- Зачем. В «Справочник → Доплата → Плановые доплаты» и в окне сотрудника «Подробно» к плановой доплате
-- пишут комментарий (за что доплата). Комментарий — часть версии журнала, как сумма и даты: переписывание
-- расписания (миграция 337) переносит его вместе с периодом, правка одного комментария — новая версия и
-- запись в «Истории изменений». У строки «снята» (amount NULL) комментария не бывает.
--
-- В расчёте ФОТ не участвует. Существующие строки получают NULL — периоды, суммы и история не меняются.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый бэкенд пишет и читает колонку. Прежний бэкенд колонку не знает и не
-- пишет — с ним миграция безопасна. Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_planned_supplements
  ADD COLUMN IF NOT EXISTS comment TEXT;

ALTER TABLE payroll_planned_supplements DROP CONSTRAINT IF EXISTS payroll_supplement_comment;
ALTER TABLE payroll_planned_supplements ADD CONSTRAINT payroll_supplement_comment CHECK (
  comment IS NULL
  OR (amount IS NOT NULL AND comment = btrim(comment) AND char_length(comment) BETWEEN 1 AND 500));

COMMENT ON COLUMN payroll_planned_supplements.comment IS
  'Комментарий периода доплаты (до 500 символов, без пробелов по краям); NULL — без комментария. '
  'У строки «снята» всегда NULL.';

COMMIT;
