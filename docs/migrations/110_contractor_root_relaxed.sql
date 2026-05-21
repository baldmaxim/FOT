-- 110_contractor_root_relaxed.sql
-- Снимает условие parent_id IS NULL у поиска корня «подрядные организации»
-- в триггере contractor_org_access_validate_root. Sigur sync принудительно
-- вешает все свои корни на синтетический узел «Объект», поэтому папка
-- «подрядные организации» из Sigur не может быть parent_id IS NULL.
-- Поиск по имени достаточно — оно специфично, конфликтов в практике нет.
-- Зеркало изменения в fot-server/src/config/contractor.ts.

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
   WHERE name = 'подрядные организации' AND is_active = true
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
