-- 227_otitb_lk_pages.sql
-- Роль ОТиТБ: доступ к «Мои заявления» и «Мои документы» в личном кабинете.
--
-- 07.07.2026 сотрудников службы охраны труда перевели с роли office на новую
-- роль otitb (миграции 209/213), которая сидировалась только вкладками
-- подрядчиков. ЛК-страницы /employee/requests и /employee/documents роли не
-- выдали, из-за чего подача заявлений (POST /api/leave-requests) и загрузка
-- вложений (POST /api/documents/upload) стали отвечать 403.
--
-- /employee/requests: edit — чинит и создание заявления, и загрузку вложения.
-- /employee/documents: edit — осознанное возвращение раздела «Мои документы»,
-- который у этих сотрудников был при прежней роли office.
--
-- Деплой кода не требуется: бэкенд подхватит строки через кэш role_page_access
-- (TTL 5 мин); пользователям после этого нужно обновить страницу/перезайти.

BEGIN;

INSERT INTO role_page_access (role_code, page_path, can_view, can_edit) VALUES
  ('otitb', '/employee/requests',  true, true),
  ('otitb', '/employee/documents', true, true)
ON CONFLICT (role_code, page_path)
DO UPDATE SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;

COMMIT;
