-- 118_contractor_root_case_insensitive.sql
-- Корень «Подрядные организации» в Sigur назван с заглавной буквы, а триггер
-- contractor_org_access_validate_root искал его регистрозависимо
-- (name = 'подрядные организации') → корень не находился, привязка падала.
-- Делаем поиск регистронезависимым. Зеркало fot-server/src/config/contractor.ts.

BEGIN;

CREATE OR REPLACE FUNCTION public.contractor_org_access_validate_root()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_id uuid;
  v_parent uuid;
BEGIN
  SELECT id INTO v_root_id
    FROM org_departments
   WHERE lower(name) = 'подрядные организации' AND is_active = true
   LIMIT 1;

  IF v_root_id IS NULL THEN
    RAISE EXCEPTION 'Root department "подрядные организации" not found';
  END IF;

  SELECT parent_id INTO v_parent
    FROM org_departments
   WHERE id = NEW.org_department_id;

  IF v_parent IS DISTINCT FROM v_root_id THEN
    RAISE EXCEPTION 'org_department_id must be a direct child of "подрядные организации"';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
