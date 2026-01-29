-- Миграция: Удаление дублирующихся столбцов структуры
-- Версия: 015
-- Дата: 2026-01-29
-- Описание: Убираем department_encrypted, subdivision_encrypted, company_encrypted,
--           оставляем только ссылки на справочники org_*

-- 1. Удаляем дублирующиеся зашифрованные столбцы
ALTER TABLE employees
  DROP COLUMN IF EXISTS department_encrypted,
  DROP COLUMN IF EXISTS subdivision_encrypted,
  DROP COLUMN IF EXISTS company_encrypted;

-- 2. Также удаляем group_name (использовался как копия department)
ALTER TABLE employees
  DROP COLUMN IF EXISTS group_name;

-- Теперь структура сотрудника использует только:
-- org_company_id → org_companies
-- org_department_id → org_departments
-- org_subdivision_id → org_subdivisions
