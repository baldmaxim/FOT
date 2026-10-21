-- 322: Плановая доплата — дата окончания необязательна (бессрочно).
--
-- Зачем. Плановые доплаты из 1С («ПлановыеДоплаты») часто без «ДатаПо»: доплата действует,
-- пока её не снимут. Миграция 293 требовала date_to у любой действующей версии — такие
-- доплаты не завести. Теперь date_to NULL у версии с суммой — «с даты», без конца;
-- в таблице «Доплата» период «с 01.02.2023». Снятая версия — по-прежнему все три поля NULL.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Прежний бэкенд бессрочную версию не пишет (zod требует date_to).
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_planned_supplements DROP CONSTRAINT IF EXISTS payroll_supplement_state;
ALTER TABLE payroll_planned_supplements ADD CONSTRAINT payroll_supplement_state CHECK (
     (amount IS NULL AND date_from IS NULL AND date_to IS NULL)
  -- amount IS NOT NULL явно: «NULL > 0» — NULL, и CHECK пропустил бы строку без суммы, но с датами.
  OR (amount IS NOT NULL AND amount > 0 AND date_from IS NOT NULL AND (date_to IS NULL OR date_to >= date_from)));

COMMENT ON COLUMN payroll_planned_supplements.amount IS
  'Доплата, ₽/мес, на период date_from — date_to включительно (date_to NULL — бессрочно). NULL — доплата снята.';
COMMENT ON COLUMN payroll_planned_supplements.date_to IS
  'Последний день доплаты включительно; NULL у версии с суммой — бессрочно.';

COMMIT;
