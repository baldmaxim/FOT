-- 101_rename_work_group_label.sql
-- Переименование группы доступов «Работа» → «Управление» (group_code='work').
-- Каталог в БД (access_pages) перекрывает дефолт в коде, поэтому название
-- блока на стр. «Управление ролями» меняется именно этой миграцией.

BEGIN;

UPDATE access_pages
   SET group_label = 'Управление', updated_at = NOW()
 WHERE group_code = 'work';

NOTIFY pgrst, 'reload schema';

COMMIT;
