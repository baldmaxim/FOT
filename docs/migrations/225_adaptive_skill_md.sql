-- 225_adaptive_skill_md.sql
-- Адаптивное тестирование: файл описания скилла (.md) в skill-профиле.
--
-- Поле «Обязанности» (duties_text, лимит 8000 символов в Zod) остаётся полем
-- для краткого описания. Развёрнутая методичка отдела загружается .md-файлом
-- в модалке профиля и хранится здесь же: содержимое нужно целиком при каждом
-- обращении к LLM, поэтому оно в БД, а не в объектном хранилище.
--
-- Содержимое замораживается в adaptive_test_sessions.profile_snapshot на старте
-- теста, поэтому замена/удаление файла не влияет на идущие сессии.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Требует применённой 224.

BEGIN;

ALTER TABLE adaptive_skill_profiles
  ADD COLUMN IF NOT EXISTS skill_md             TEXT,
  ADD COLUMN IF NOT EXISTS skill_md_filename    TEXT,
  ADD COLUMN IF NOT EXISTS skill_md_chars       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skill_md_uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS skill_md_uploaded_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL;

ALTER TABLE adaptive_skill_profiles
  DROP CONSTRAINT IF EXISTS adaptive_skill_profiles_skill_md_chars_check;
ALTER TABLE adaptive_skill_profiles
  ADD CONSTRAINT adaptive_skill_profiles_skill_md_chars_check CHECK (skill_md_chars >= 0);

COMMENT ON COLUMN adaptive_skill_profiles.skill_md IS
  'Описание скилла отдела: содержимое загруженного .md-файла. Целиком уходит в LLM при генерации и оценке.';
COMMENT ON COLUMN adaptive_skill_profiles.skill_md_filename IS
  'Имя загруженного файла — только для отображения в админке.';
COMMENT ON COLUMN adaptive_skill_profiles.skill_md_chars IS
  'Длина содержимого в символах; считается сервером при сохранении.';

NOTIFY pgrst, 'reload schema';

COMMIT;
