-- Откат 376: файлы шаблонов графиков работы.
--
-- Порядок: сначала вернуть бэкенд на версию до 376 (список графиков считает files_count по этой таблице),
-- затем этот файл.
--
-- Таблица удаляется ТОЛЬКО пустой: строки — единственная связь с объектами R2 (work-schedules/<id>/...),
-- без них файлы останутся в хранилище недоступными сиротами. Если файлы есть, откат падает с их числом —
-- сначала выгрузите ключи и удалите объекты R2:
--   \copy (SELECT schedule_id, r2_key, file_name FROM work_schedule_files ORDER BY schedule_id, id) TO 'work_schedule_files.csv' CSV HEADER
-- Повторное применение 376 после отката безопасно.

BEGIN;

DO $$
DECLARE
  files_total BIGINT;
BEGIN
  IF to_regclass('public.work_schedule_files') IS NOT NULL THEN
    SELECT count(*) INTO files_total FROM work_schedule_files;
    IF files_total > 0 THEN
      RAISE EXCEPTION 'work_schedule_files: % файл(ов) — откат удалил бы связь с объектами R2. Выгрузите и удалите их, затем повторите.', files_total;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS work_schedule_files;

-- Без DELETE из schema_migrations раннер не применит 376 повторно.
DELETE FROM schema_migrations WHERE filename = '376_work_schedule_files.sql';

COMMIT;
