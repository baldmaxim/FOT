-- 083_user_company_access.sql
-- Скоуп администратора по компаниям. «Компания» = прямой ребёнок корневого
-- синтетического узла org_departments с name='Объект'. Если у админа
-- НЕТ записей в этой таблице — он системный (видит всё). Если есть —
-- видит только поддеревья назначенных корней.

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_company_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  company_root_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  CONSTRAINT user_company_access_unique UNIQUE (user_id, company_root_id)
);

CREATE INDEX IF NOT EXISTS user_company_access_user_idx
  ON public.user_company_access(user_id);
CREATE INDEX IF NOT EXISTS user_company_access_root_idx
  ON public.user_company_access(company_root_id);

-- Триггер: company_root_id обязан быть прямым ребёнком корневого «Объект».
CREATE OR REPLACE FUNCTION public.user_company_access_validate_root()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_object_id uuid;
  v_parent uuid;
BEGIN
  SELECT id INTO v_object_id
    FROM org_departments
   WHERE parent_id IS NULL AND name = 'Объект'
   LIMIT 1;

  IF v_object_id IS NULL THEN
    RAISE EXCEPTION 'Root department "Объект" not found';
  END IF;

  SELECT parent_id INTO v_parent
    FROM org_departments
   WHERE id = NEW.company_root_id;

  IF v_parent IS DISTINCT FROM v_object_id THEN
    RAISE EXCEPTION 'company_root_id must be a direct child of root "Объект"';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_company_access_validate_root_trg ON public.user_company_access;
CREATE TRIGGER user_company_access_validate_root_trg
  BEFORE INSERT OR UPDATE ON public.user_company_access
  FOR EACH ROW EXECUTE FUNCTION public.user_company_access_validate_root();

-- RPC: рекурсивно вернуть все id-ы поддерева для массива корней
-- (включая сами корни). Используется data-scope.service.ts.
CREATE OR REPLACE FUNCTION public.get_descendant_department_ids(p_root_ids uuid[])
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE tree AS (
    SELECT d.id, d.parent_id
      FROM org_departments d
     WHERE d.id = ANY(p_root_ids)
    UNION ALL
    SELECT d.id, d.parent_id
      FROM org_departments d
      JOIN tree t ON d.parent_id = t.id
  )
  SELECT t.id FROM tree t;
$$;

ALTER TABLE public.user_company_access ENABLE ROW LEVEL SECURITY;

COMMIT;
