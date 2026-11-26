-- Откат 380: «Обновление документов», справочное «Начало компенсации», файлы компенсации аренды.
--
-- Порядок: сначала вернуть бэкенд на версию до 380 (он пишет колонки и считает файлы), затем этот файл.
--
-- Таблица файлов удаляется ТОЛЬКО пустой: строки — единственная связь с объектами R2 (dormitory-compensation/<id>/...),
-- без них файлы останутся в хранилище недоступными сиротами. Если файлы есть, откат падает с их числом —
-- сначала выгрузите ключи и удалите объекты R2:
--   \copy (SELECT employee_id, r2_key, file_name FROM dormitory_compensation_files ORDER BY employee_id, id) TO 'dormitory_compensation_files.csv' CSV HEADER
-- Колонки docs_updated_on и since_on удаляются вместе с данными: справочные даты «Начала» и «Обновление документов»
-- пропадут (расчёт не меняется — он по check_in). Повторное применение 380 после отката безопасно.

BEGIN;

DO $$
DECLARE
  files_total BIGINT;
BEGIN
  IF to_regclass('public.dormitory_compensation_files') IS NOT NULL THEN
    SELECT count(*) INTO files_total FROM dormitory_compensation_files;
    IF files_total > 0 THEN
      RAISE EXCEPTION 'dormitory_compensation_files: % файл(ов) — откат удалил бы связь с объектами R2. Выгрузите и удалите их, затем повторите.', files_total;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS dormitory_compensation_files;

ALTER TABLE employee_dormitory_stays DROP CONSTRAINT IF EXISTS employee_dormitory_stay_since;
ALTER TABLE employee_dormitory_stays DROP CONSTRAINT IF EXISTS employee_dormitory_stay_docs_updated;
ALTER TABLE employee_dormitory_stays DROP COLUMN IF EXISTS since_on;
ALTER TABLE employee_dormitory_stays DROP COLUMN IF EXISTS docs_updated_on;

-- Без DELETE из schema_migrations раннер не применит 380 повторно.
DELETE FROM schema_migrations WHERE filename = '380_dormitory_compensation_docs_files.sql';

COMMIT;
