-- 221_role_admin_access.sql
-- Роли: явный «Доступ в админку» вместо неявной зависимости от страницы /dashboard.
--
-- 1. access_pages.area ('personal' | 'admin') — каталог прав делится на ЛК и админку.
--    Раньше блок «Моё» (group_code='mine') смешивал /employee/* с /dashboard,
--    /leave-requests, /skud-presence.
-- 2. system_roles.admin_access — роль вообще попадает в админку (сайдбар + серверный гейт).
-- 3. system_roles.manager_auto_access — авто-выдача /staff-control и /timesheet
--    «руководителям» (назначенные отделы / прямые подчинённые). Раньше срабатывала
--    для всех не-админов, минуя роль: менеджер МТС с назначенным отделом получал
--    «Управление кадрами».
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА.

BEGIN;

-- ── 1. Каталог страниц: область (ЛК / админка) ──────────────────────────────
ALTER TABLE access_pages
  ADD COLUMN IF NOT EXISTS area TEXT NOT NULL DEFAULT 'admin';

ALTER TABLE access_pages
  DROP CONSTRAINT IF EXISTS access_pages_area_check;
ALTER TABLE access_pages
  ADD CONSTRAINT access_pages_area_check CHECK (area IN ('personal', 'admin'));

-- Личный кабинет. Префикс сверяем точно: '/employees' («Карточка сотрудника») —
-- это админка, а не ЛК. '/contractor' — кабинет подрядчика, тоже ЛК
-- (иначе роль подрядчика без admin_access потеряла бы свой раздел).
UPDATE access_pages
   SET area = 'personal',
       group_code = 'lk',
       group_label = 'Личный кабинет',
       updated_at = NOW()
 WHERE key = '/employee' OR key LIKE '/employee/%' OR key = '/contractor';

-- «Обзор и заявления» — это уже админка, а не «Моё»
UPDATE access_pages
   SET area = 'admin',
       group_code = 'overview',
       group_label = 'Обзор и заявления',
       updated_at = NOW()
 WHERE key IN ('/dashboard', '/leave-requests', '/salary-raise-review', '/leave-vacations', '/skud-presence');

-- Дубль-группа «Управление» (миграция обратной связи) — слить с work
UPDATE access_pages
   SET group_code = 'work',
       group_label = 'Управление',
       updated_at = NOW()
 WHERE group_code = 'operations';

-- Остаток группы mine (если что-то осталось) — в админку
UPDATE access_pages
   SET area = 'admin', group_code = 'work', group_label = 'Управление', updated_at = NOW()
 WHERE group_code = 'mine';

-- ── 2. Роли: доступ в админку ───────────────────────────────────────────────
ALTER TABLE system_roles
  ADD COLUMN IF NOT EXISTS admin_access BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN system_roles.admin_access IS
  'Роль имеет доступ в админку (не только личный кабинет). Выкл = все админ-ключи вырезаются из page_access.';

-- Бэкфилл: админы + роли, у которых уже есть хоть одна админ-страница
UPDATE system_roles SET admin_access = true WHERE is_admin = true;

UPDATE system_roles r
   SET admin_access = true
 WHERE r.admin_access = false
   AND EXISTS (
     SELECT 1
       FROM role_page_access rpa
       JOIN access_pages ap ON ap.key = rpa.page_path
      WHERE rpa.role_code = r.code
        AND rpa.can_view = true
        AND ap.area = 'admin'
   );

-- ── 3. Роли: авто-доступ руководителя ───────────────────────────────────────
ALTER TABLE system_roles
  ADD COLUMN IF NOT EXISTS manager_auto_access BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN system_roles.manager_auto_access IS
  'Авто-выдача «Управление кадрами» / «Табель» / «Заявки на поиск» пользователям с назначенными отделами или прямыми подчинёнными.';

-- Узкие роли: раздел один, кадры им не нужны
UPDATE system_roles SET manager_auto_access = false WHERE code IN ('mts_manager', 'otitb');

-- ── 4. Менеджер МТС: /dashboard больше не нужен как «ключ от админки» ───────
UPDATE system_roles SET admin_access = true WHERE code = 'mts_manager';

DELETE FROM role_page_access
 WHERE role_code = 'mts_manager' AND page_path = '/dashboard';

NOTIFY pgrst, 'reload schema';

COMMIT;
