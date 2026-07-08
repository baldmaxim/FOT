-- 213_contractor_inducted_persons.sql
-- Реестр сотрудников подрядчика, прошедших ВВОДНЫЙ ИНСТРУКТАЖ (ОТиТБ).
--
-- Отдельный справочник-подсказка: ответственный ОТиТБ заранее заводит сотрудников
-- по каждой подрядной организации. Подрядчик в своём кабинете при заполнении
-- НОВОГО пропуска выбирает ФИО из этого списка (datalist) вместо ручного ввода.
--
-- ВАЖНО: это ТОЛЬКО справочник. Он НЕ меняет contractor_passes / заявки / статусы
-- и НЕ выставляет автоматически induction_passed. Пер-пропускную галочку инструктажа
-- ОТиТБ по-прежнему ставит вручную на вкладке «Заявки на согласование» (миграция 209).
-- Никаких UPDATE существующих данных здесь нет — уже поданные заявки не затрагиваются.

BEGIN;

-- 1. Таблица реестра. Без UNIQUE по ФИО — бывают полные тёзки (уникальность
--    требовала бы даты рождения). Индекс (org, full_name) — только для поиска.
CREATE TABLE IF NOT EXISTS public.contractor_inducted_persons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  full_name         text NOT NULL,
  inducted_on       date NOT NULL DEFAULT CURRENT_DATE,   -- колонка «Дата»
  created_by        uuid NULL,                             -- app_auth.users.id, без жёсткого FK
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cip_org
  ON public.contractor_inducted_persons(org_department_id);
CREATE INDEX IF NOT EXISTS idx_cip_org_name
  ON public.contractor_inducted_persons(org_department_id, full_name);

-- 2. Технический ключ вкладки «ОТиТБ» в каталоге страниц (как /submissions в 209).
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES
  ('/admin/contractor-approvals/otitb', 'Подрядчики — ОТиТБ (вкладка)',
   'admin', 'Администрирование', 'technical', true, 244, true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- 3. Доступ роли ОТиТБ к новой вкладке (роль создана в 209).
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('otitb', '/admin/contractor-approvals/otitb', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
