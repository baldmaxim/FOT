-- 065_role_page_access_view_implies_edit.sql
--
-- Защита-в-глубине от аномалий в матрице доступа.
-- Семантика: edit подразумевает view (любой, кто может редактировать,
-- по определению может смотреть). Сейчас сервер нормализует это на чтении
-- кэша (services/access-control.service.ts), но в самой схеме инварианта
-- не было — значит ручной INSERT/UPDATE мог записать {can_view:false, can_edit:true}
-- и фронт, читающий can_view напрямую, потерял бы доступ для админов /
-- получил бы рассинхрон с сервером.
--
-- Применяется вручную через psql на проде:
--   psql "$DATABASE_URL" -f docs/migrations/065_role_page_access_view_implies_edit.sql

BEGIN;

-- 1. Чиним возможные «битые» записи — выставляем can_view=true там, где есть can_edit.
UPDATE role_page_access
SET    can_view = true
WHERE  can_edit = true
  AND  can_view = false;

-- 2. Закрепляем инвариант на уровне схемы.
ALTER TABLE role_page_access
  ADD CONSTRAINT chk_view_implies_edit
  CHECK (NOT (can_edit AND NOT can_view));

COMMIT;
