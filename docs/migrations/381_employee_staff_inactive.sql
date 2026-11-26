-- 381: «Управление кадрами» → статус «Неактивный» и флаги учёток.
--
-- Зачем (решения пользователя 26.11.2026):
--   «Текущие сотрудники» делятся на «Активные | Уволенные | Все». Неактивный — не уволенный сотрудник, который не
--   работает: отдел «Декрет»/«Архив» (по имени отдела или предка, считается в коде — employee-inactive.service.ts) или
--   ручная метка ниже. Неактивного нет в «Активных», вход на портал ему закрыт.
--
--   employees.staff_inactive_at / staff_inactive_by — ручная метка «Перевести в неактивные» и кто её поставил.
--     Снимают «Вернуть в активные», увольнение и восстановление. employment_status не меняется: табель, зарплата,
--     1С и Sigur неактивность не видят.
--     staff_inactive_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285, стережёт
--     npm run audit:user-fk).
--   user_profiles.can_manage_staff_inactive — учётке доступны кнопки «Перевести в неактивные» / «Вернуть в активные».
--     В портале не выдаётся: только разовым SQL (сейчас — Чепиков П. В.).
--   user_profiles.login_when_staff_inactive — служебная учётка: «Неактивный» вход не закрывает (увольнение закрывает).
--     Только разовым SQL (сейчас — «Учет проживания сотрудников», карточка в «Архиве»).
--
-- Флаги ставит docs/manual-migrations/staff_inactive_flags_2026-11-26.sql — ДО деплоя бэкенда.
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (deploy-server.sh migrate). Повторный запуск безопасен. Откат — docs/rollbacks/381_*.
-- Номер 381: 380 — 380_dormitory_compensation_docs_files.sql.

BEGIN;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS staff_inactive_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS staff_inactive_by uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.employees.staff_inactive_at IS
  'Ручная метка «Неактивный» (миграция 381): с какого момента. NULL — не переведён вручную; «Декрет»/«Архив» — по отделу, без метки.';
COMMENT ON COLUMN public.employees.staff_inactive_by IS
  'Кто перевёл в неактивные (миграция 381).';

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS can_manage_staff_inactive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS login_when_staff_inactive boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_profiles.can_manage_staff_inactive IS
  'Кнопки «Перевести в неактивные» / «Вернуть в активные» (миграция 381). Только SQL, в портале не выдаётся.';
COMMENT ON COLUMN public.user_profiles.login_when_staff_inactive IS
  'Служебная учётка: неактивность карточки вход не закрывает, увольнение — закрывает (миграция 381). Только SQL.';

COMMIT;
