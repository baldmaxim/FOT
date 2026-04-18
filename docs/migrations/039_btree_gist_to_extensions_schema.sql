-- Переносим btree_gist из public в extensions (рекомендация Supabase).
-- Проверено: в БД нет ни EXCLUDE-констрейнтов, ни GiST-индексов, использующих btree_gist.
-- Advisor закрывает: extension_in_public.

ALTER EXTENSION btree_gist SET SCHEMA extensions;
