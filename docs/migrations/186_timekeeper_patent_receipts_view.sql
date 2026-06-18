-- 186: роль «Табельщица» (timekeeper) — просмотр страницы «Чеки за патент»
-- can_view = true, can_edit = false: список/фильтры/поиск доступны,
-- добавление/удаление/редактирование/перераспознавание — нет (мутации требуют edit).

INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES ('timekeeper', '/admin/patent-receipts', true, false)
ON CONFLICT (role_code, page_path)
  DO UPDATE SET can_view = true, can_edit = false;
