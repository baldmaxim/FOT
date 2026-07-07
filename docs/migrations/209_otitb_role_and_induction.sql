-- 209_otitb_role_and_induction.sql
-- Роль «ОТиТБ» (ответственный за охрану труда и технику безопасности) +
-- вводный инструктаж держателя подрядного пропуска.
--
-- ОТиТБ — узкая роль с единственным write-действием: отметить вводный
-- инструктаж на вкладке «Заявки на согласование» раздела «Подрядчики».
-- Доступ выдаётся техническим ключом /admin/contractor-approvals/submissions
-- (полный ключ /admin/contractor-approvals роли НЕ даём).
--
-- ВНИМАНИЕ (операционное последствие): induction_passed DEFAULT false — после
-- накатки все текущие pending-пропуска станут неоткрываемыми, пока их не
-- отметят инструктажем. Это соответствует смыслу фичи. Если требуется НЕ
-- блокировать текущую очередь — раскомментировать backfill в конце файла.

BEGIN;

-- 1. Вводный инструктаж на пропуске (операционно/юридически значимый факт —
--    храним не только флаг, но и когда/кем отмечено).
ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS induction_passed    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS induction_passed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS induction_passed_by uuid NULL;   -- app_auth.users.id, без жёсткого FK

-- 2. Технический ключ вкладки «Заявки на согласование» в каталоге страниц.
--    surface='technical' — не показывается отдельным пунктом меню, но участвует
--    в матрице доступа (как /admin/schedules/templates).
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES
  ('/admin/contractor-approvals/submissions', 'Подрядчики — Заявки на согласование (вкладка)',
   'admin', 'Администрирование', 'technical', true, 243, true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- 3. Роль ОТиТБ (актуальная схема после 044_simplify_roles.sql).
--    Не админ, без типа личного кабинета (employee_variant=NULL).
INSERT INTO system_roles (code, name, description, is_admin, employee_variant, is_active)
VALUES ('otitb', 'ОТиТБ', 'Ответственный за охрану труда и технику безопасности', false, NULL, true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_admin = false,
  is_active = true;

-- 4. Доступ ОТиТБ: только техническая вкладка «Заявки на согласование».
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('otitb', '/admin/contractor-approvals/submissions', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

-- 5. (опционально) не блокировать уже стоящую очередь на согласовании:
-- UPDATE public.contractor_passes SET induction_passed = true WHERE approval_status = 'pending';

NOTIFY pgrst, 'reload schema';

COMMIT;
