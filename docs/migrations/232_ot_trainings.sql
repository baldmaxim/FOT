-- 232_ot_trainings.sql
-- Обучение по охране труда для сотрудников подрядчиков (вкладка «Подрядчики → ОТиТБ»).
--
-- Было: одна дата вводного инструктажа в contractor_inducted_persons.inducted_on (миграция 213).
-- Стало: дочерняя таблица с датой по каждому виду обучения (вводный, на рабочем месте,
-- протокол ОТ, программы Б/В/СИЗ/ПП, стажировка, допуск). Дата окончания НЕ хранится —
-- считается из периодичности в коде (fot-server/src/services/ot-training.service.ts).
--
-- Почему дочерняя таблица, а не 9 колонок: каталог видов всё равно ведётся в коде, а
-- добавление вида не должно требовать миграцию. Запись «поставить/снять дату по виду»
-- ложится 1:1 на INSERT ... ON CONFLICT / DELETE.
--
-- Legacy-колонка inducted_on НЕ удаляется в этой миграции: новый бэк пишет её вторым
-- (dual-write), поэтому откат бэка не теряет данные. Снимается уборочной миграцией
-- после закрытия rollback-окна вместе с переходным триггером.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.
-- ПЕРЕД ПРИМЕНЕНИЕМ — дамп contractor_inducted_persons и контрольный count(*).

BEGIN;

-- 1. Справочник кодов видов обучения. FK на него не даёт записать опечатку, которая
--    стала бы невидимой приложению. Подписи и периодичность живут в коде — тут только коды.
CREATE TABLE IF NOT EXISTS public.ot_training_kinds (
  code text PRIMARY KEY
);

INSERT INTO public.ot_training_kinds (code) VALUES
  ('introductory'),    -- Вводный инструктаж (бессрочно)
  ('workplace'),       -- Инструктаж на рабочем месте (3 месяца)
  ('protocol'),        -- Протокол ОТ с внесением в реестр Минтруда (3 года)
  ('program_a'),       -- Программа А «Общие вопросы ОТ» (3 года, ТОЛЬКО ИТР)
  ('program_b'),       -- Программа Б «Безопасные методы при вредных/опасных факторах» (3 года)
  ('program_v'),       -- Программа В «Работы повышенной опасности» (3 года)
  ('siz'),             -- Обучение применению СИЗ (3 года)
  ('first_aid'),       -- Первая помощь пострадавшим (3 года)
  ('internship'),      -- Стажировка (разово)
  ('work_admission')   -- Допуск к самостоятельной работе (разово)
ON CONFLICT (code) DO NOTHING;

-- 2. Даты обучения. Снятие даты = DELETE строки, поэтому passed_on NOT NULL.
CREATE TABLE IF NOT EXISTS public.contractor_person_trainings (
  person_id  uuid        NOT NULL REFERENCES public.contractor_inducted_persons(id) ON DELETE CASCADE,
  kind       text        NOT NULL REFERENCES public.ot_training_kinds(code),
  passed_on  date        NOT NULL,
  updated_by uuid        NULL,           -- app_auth.users.id, без жёсткого FK (как в 213)
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, kind)
);

COMMENT ON TABLE public.contractor_person_trainings IS
  'Даты обучения по ОТ сотрудника подрядчика. Дата окончания не хранится — считается из периодичности в коде.';

-- 3. Архивирование вместо физического удаления: hard DELETE каскадом уносил бы всю
--    историю обучения. Плюс ревизия updated_at для optimistic concurrency в PATCH.
ALTER TABLE public.contractor_inducted_persons
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS deleted_by uuid NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_cip_org_active
  ON public.contractor_inducted_persons(org_department_id) WHERE deleted_at IS NULL;

-- 4. Legacy-колонка перестаёт врать: DEFAULT CURRENT_DATE проставлял «инструктаж пройден
--    сегодня» человеку, у которого вводного инструктажа нет. Теперь без вводного — NULL.
ALTER TABLE public.contractor_inducted_persons ALTER COLUMN inducted_on DROP DEFAULT;
ALTER TABLE public.contractor_inducted_persons ALTER COLUMN inducted_on DROP NOT NULL;

-- 5. Бэкфилл вводного инструктажа из legacy-колонки.
INSERT INTO public.contractor_person_trainings (person_id, kind, passed_on, updated_by, created_at)
SELECT id, 'introductory', inducted_on, created_by, created_at
  FROM public.contractor_inducted_persons
 WHERE inducted_on IS NOT NULL
ON CONFLICT (person_id, kind) DO NOTHING;

-- 6. Переходный триггер: закрывает окно между бэкфиллом и деплоем нового бэка. Старый код
--    пишет только inducted_on — без триггера такие записи новый бэк увидел бы как «нет
--    вводного инструктажа». Для нового бэка триггер холостой: он пишет обе стороны
--    одинаковым значением, повторный upsert ничего не меняет.
--    Снимается уборочной миграцией после закрытия rollback-окна.
CREATE OR REPLACE FUNCTION public.sync_legacy_inducted_on() RETURNS trigger AS $$
BEGIN
  IF NEW.inducted_on IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.inducted_on IS DISTINCT FROM OLD.inducted_on) THEN
    INSERT INTO public.contractor_person_trainings (person_id, kind, passed_on)
    VALUES (NEW.id, 'introductory', NEW.inducted_on)
    ON CONFLICT (person_id, kind) DO UPDATE
       SET passed_on = EXCLUDED.passed_on, updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_legacy_inducted_on ON public.contractor_inducted_persons;
CREATE TRIGGER trg_sync_legacy_inducted_on
  AFTER INSERT OR UPDATE OF inducted_on ON public.contractor_inducted_persons
  FOR EACH ROW EXECUTE FUNCTION public.sync_legacy_inducted_on();

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Сверка после применения (обе строки должны дать 0 / пусто):
--   SELECT count(*) FROM contractor_inducted_persons p
--     LEFT JOIN contractor_person_trainings t ON t.person_id = p.id AND t.kind = 'introductory'
--    WHERE p.deleted_at IS NULL AND p.inducted_on IS DISTINCT FROM t.passed_on;
--   SELECT DISTINCT kind FROM contractor_person_trainings
--    WHERE kind NOT IN (SELECT code FROM ot_training_kinds);
