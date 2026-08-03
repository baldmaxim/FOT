-- 235_mts_business_phonebook_hidden.sql
-- МТС Бизнес → «Абоненты»: тоггл «Не отображать» — скрытие номера из «Телефонной
-- книги» ЛК сотрудника (/employee/phonebook). Флаг хранится на номере в
-- mts_business_number_map, фильтрация серверная в getPhonebook().
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE public.mts_business_number_map
  ADD COLUMN IF NOT EXISTS phonebook_hidden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.mts_business_number_map.phonebook_hidden IS
  'Скрыть номер из «Телефонной книги» ЛК сотрудника (тоггл «Не отображать» на вкладке Абоненты)';

COMMIT;
