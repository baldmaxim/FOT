-- 237: пер-ролевой флаг «Просмотр всех табелей и проходов (только чтение)».
-- Роль с флагом видит все отделы организации на чтение в табеле и СКУД-проходах.
-- Применять ДО деплоя бэкенда (roles-cache перечисляет колонки явно).
ALTER TABLE system_roles
  ADD COLUMN IF NOT EXISTS view_all_departments boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN system_roles.view_all_departments IS
  'true → роль видит все табели и СКУД-проходы организации на чтение. Не применяется к is_admin и timekeeper. Editable-scope не расширяет.';
