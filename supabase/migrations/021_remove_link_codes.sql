-- Миграция: Удаление системы Link Codes
-- Версия: 021
-- Дата: 2026-01-29
-- Описание: Убираем коды привязки - регистрация будет через email

-- ============================================
-- 1. Удалить FK из user_profiles
-- ============================================
ALTER TABLE user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_link_code_id_fkey;

ALTER TABLE user_profiles
  DROP COLUMN IF EXISTS link_code_id;

-- ============================================
-- 2. Удалить таблицу employee_link_codes
-- ============================================
DROP TABLE IF EXISTS employee_link_codes;

-- ============================================
-- 3. Добавить employee_id в user_profiles для прямой связи
-- ============================================
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_employee
  ON user_profiles(employee_id) WHERE employee_id IS NOT NULL;

COMMENT ON COLUMN user_profiles.employee_id IS 'Связь с сотрудником (заполняется вручную администратором)';
