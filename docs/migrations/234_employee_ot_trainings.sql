-- 234_employee_ot_trainings.sql
-- Полный цикл обучения по охране труда для СВОИХ сотрудников (вкладка «Управление кадрами →
-- Вводный инструктаж»): протокол ОТ, программы А/Б/В, СИЗ, первая помощь, стажировка, допуск
-- к самостоятельной работе и обучение по сквозным профессиям.
--
-- У подрядчиков остаётся единственный вид — вводный инструктаж (миграция 232), весь остальной
-- цикл ведут кадры здесь. Схема зеркалит contractor_person_trainings, плюс колонка note под
-- профессию у вида cross_profession.
--
-- employee_inductions НЕ удаляется: на её inducted_on держатся фильтр «Без инструктажа /
-- Пройден» и счётчик «Пройдено N из M», а также откат бэкенда. Новый сервис пишет обе таблицы
-- (dual-write), а переходный триггер доносит правки СТАРОГО кода в новую таблицу.
--
-- ПРИМЕНЯТЬ ПОСЛЕ 233 И ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.
-- ПЕРЕД ПРИМЕНЕНИЕМ — дамп employee_inductions и контрольный count(*).

BEGIN;

-- 1. Новый код вида в справочнике (остальные заведены в 232).
INSERT INTO public.ot_training_kinds (code) VALUES
  ('cross_profession')   -- Обучение по сквозным профессиям (разово, профессия вручную)
ON CONFLICT (code) DO NOTHING;

-- 2. Даты обучения своих сотрудников. Снятие даты = DELETE строки, поэтому passed_on NOT NULL.
CREATE TABLE IF NOT EXISTS public.employee_ot_trainings (
  employee_id integer     NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  kind        text        NOT NULL REFERENCES public.ot_training_kinds(code),
  passed_on   date        NOT NULL,
  note        text        NULL,          -- профессия; заполняется только у cross_profession
  updated_by  uuid        NULL,          -- app_auth.users.id, без жёсткого FK (как в 231/232)
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, kind)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employee_ot_trainings_note_chk'
  ) THEN
    ALTER TABLE public.employee_ot_trainings
      ADD CONSTRAINT employee_ot_trainings_note_chk
      CHECK (note IS NULL OR kind = 'cross_profession');
  END IF;
END $$;

COMMENT ON TABLE public.employee_ot_trainings IS
  'Даты обучения по ОТ своего сотрудника. Дата окончания не хранится — считается из периодичности в коде.';
COMMENT ON COLUMN public.employee_ot_trainings.note IS
  'Профессия для вида cross_profession («Монтажник» и т.п.).';

-- 3. Бэкфилл из employee_inductions (миграции 231 и 233).
INSERT INTO public.employee_ot_trainings (employee_id, kind, passed_on, updated_by, created_at)
SELECT employee_id, 'introductory', inducted_on, updated_by, created_at
  FROM public.employee_inductions
 WHERE inducted_on IS NOT NULL
ON CONFLICT (employee_id, kind) DO NOTHING;

INSERT INTO public.employee_ot_trainings (employee_id, kind, passed_on, updated_by, created_at)
SELECT employee_id, 'program_a', program_a_on, updated_by, created_at
  FROM public.employee_inductions
 WHERE program_a_on IS NOT NULL
ON CONFLICT (employee_id, kind) DO NOTHING;

-- 4. Переходный триггер employee_inductions → employee_ot_trainings.
--    Разового бэкфилла мало: старый PATCH /employees/:id/induction пишет только в
--    employee_inductions, и его правки (окно между миграцией и деплоем, старый фронт во время
--    выкладки, legacy-endpoint после релиза) иначе не доедут в новую таблицу.
--    Для нового бэка триггер холостой: он пишет те же значения, а IS DISTINCT FROM гасит повтор.
--    Снимается уборочной миграцией вместе с legacy-колонками.
CREATE OR REPLACE FUNCTION public.sync_employee_induction_trainings() RETURNS trigger AS $$
DECLARE
  pair record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.employee_ot_trainings
     WHERE employee_id = OLD.employee_id AND kind IN ('introductory', 'program_a');
    RETURN OLD;
  END IF;

  FOR pair IN
    SELECT 'introductory'::text AS kind, NEW.inducted_on AS d
    UNION ALL
    SELECT 'program_a', NEW.program_a_on
  LOOP
    IF pair.d IS NULL THEN
      DELETE FROM public.employee_ot_trainings
       WHERE employee_id = NEW.employee_id AND kind = pair.kind;
    ELSE
      INSERT INTO public.employee_ot_trainings (employee_id, kind, passed_on, updated_by)
      VALUES (NEW.employee_id, pair.kind, pair.d, NEW.updated_by)
      ON CONFLICT (employee_id, kind) DO UPDATE
         SET passed_on = EXCLUDED.passed_on,
             updated_at = now()
       WHERE public.employee_ot_trainings.passed_on IS DISTINCT FROM EXCLUDED.passed_on;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_employee_induction_trainings ON public.employee_inductions;
CREATE TRIGGER trg_sync_employee_induction_trainings
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_inductions
  FOR EACH ROW EXECUTE FUNCTION public.sync_employee_induction_trainings();

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Сверка после применения (обе строки должны дать 0 / пусто):
--   SELECT count(*) FROM employee_inductions i
--     LEFT JOIN employee_ot_trainings t
--            ON t.employee_id = i.employee_id AND t.kind = 'introductory'
--    WHERE i.inducted_on IS DISTINCT FROM t.passed_on;
--   SELECT DISTINCT kind FROM employee_ot_trainings
--    WHERE kind NOT IN (SELECT code FROM ot_training_kinds);
