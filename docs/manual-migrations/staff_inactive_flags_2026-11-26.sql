-- One-off data fix, not a migration. ASCII on purpose. NO COMMIT in this file.
--
-- "Upravlenie kadrami" -> status "Neaktivnyi" (migration 381, user decisions 26.11.2026). Sets two profile flags that
-- the portal never sets itself:
--
--   profile                                employee  flag                          why
--   a51b9047-273c-445f-bf7a-e186ced3f65d   2063      can_manage_staff_inactive     Chepikov P. V. - the only one with the
--                                                                                  buttons "v neaktivnye" / "vernut v aktivnye"
--   a4568fc6-c448-4f90-b9a4-02b774de4fcc   15745     login_when_staff_inactive     service login "Uchet prozhivaniya
--                                                                                  sotrudnikov": its card is in "Arkhiv"
--                                                                                  (inactive), the login must keep working
--
-- RUN AFTER MIGRATION 381 AND BEFORE THE BACKEND: the new backend closes the portal for every inactive card, and
-- without login_when_staff_inactive the housing login stops working.
--
-- STOP checks (nothing is applied on any difference):
--   * columns of migration 381 exist;
--   * both profiles exist and are linked to employees 2063 / 15745;
--   * the department rule ("Dekret" / "Arkhiv" by name of the department or a parent) finds exactly the two roots
--     SU-10/Dekret (712d1d45-...) and SU-10/Arkhiv (19e1ca6c-...), 25 not fired employees in them and exactly two
--     linked profiles: f55362ff-... (employee 649, Zolotenkova A. E. - loses the login, as decided) and the housing
--     login above. A new "Arkhiv"/"Dekret" department or a new login there means more people lose the portal -
--     review before the backend.
-- A second run is safe: flags already set are reported, not changed.
--
-- Run in interactive psql (see DEPLOY.md for DATABASE_URL and PGSSLROOTCERT):
--   psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
--   \i ~/staff_inactive_flags_2026-11-26.sql
-- Compare the output with the \echo text at the end, then type one of:
--   COMMIT;
--   ROLLBACK;
-- Rows stay locked until then (idle_in_transaction_session_timeout rolls it back after 3 minutes).
--
-- Undo after COMMIT (before the backend is rolled back, the housing login would be blocked again):
--   UPDATE user_profiles SET can_manage_staff_inactive = false WHERE id = 'a51b9047-273c-445f-bf7a-e186ced3f65d';
--   UPDATE user_profiles SET login_when_staff_inactive = false WHERE id = 'a4568fc6-c448-4f90-b9a4-02b774de4fcc';

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '3min';

DO $fix$
DECLARE
  c_chepikov  CONSTANT uuid := 'a51b9047-273c-445f-bf7a-e186ced3f65d';
  c_housing   CONSTANT uuid := 'a4568fc6-c448-4f90-b9a4-02b774de4fcc';
  c_roots     CONSTANT uuid[] := ARRAY['19e1ca6c-c93a-486c-bd09-caae0dbfaa93', '712d1d45-0e34-4179-b6fe-8962e27f6277']::uuid[];
  c_profiles  CONSTANT text[] := ARRAY['a4568fc6-c448-4f90-b9a4-02b774de4fcc:15745', 'f55362ff-8d91-46b9-8e16-813e67ddae8a:649'];
  -- 'dekret' and 'arkhiv' in Cyrillic, lower case.
  c_names     CONSTANT text[] := ARRAY[U&'\0434\0435\043A\0440\0435\0442', U&'\0430\0440\0445\0438\0432'];
  v_roots     uuid[];
  v_employees integer;
  v_profiles  text[];
  v_count     integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'user_profiles' AND column_name IN ('can_manage_staff_inactive', 'login_when_staff_inactive'))
       OR (table_name = 'employees' AND column_name IN ('staff_inactive_at', 'staff_inactive_by')));
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'STOP: migration 381 is not applied (found % of 4 columns)', v_count;
  END IF;

  PERFORM 1 FROM user_profiles WHERE id = c_chepikov AND employee_id = 2063 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STOP: profile % is missing or not linked to employee 2063', c_chepikov;
  END IF;
  PERFORM 1 FROM user_profiles WHERE id = c_housing AND employee_id = 15745 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STOP: profile % is missing or not linked to employee 15745', c_housing;
  END IF;

  WITH RECURSIVE roots AS (
    SELECT id FROM org_departments WHERE lower(btrim(name)) = ANY(c_names)
  ), tree AS (
    SELECT id FROM roots
    UNION
    SELECT d.id FROM org_departments d JOIN tree t ON d.parent_id = t.id
  )
  SELECT (SELECT array_agg(id ORDER BY id) FROM roots),
         (SELECT count(*) FROM employees e
           WHERE e.org_department_id IN (SELECT id FROM tree)
             AND e.employment_status <> 'fired' AND e.is_archived = false),
         (SELECT array_agg(up.id::text || ':' || up.employee_id ORDER BY up.id)
            FROM user_profiles up JOIN employees e ON e.id = up.employee_id
           WHERE e.org_department_id IN (SELECT id FROM tree) AND e.employment_status <> 'fired')
    INTO v_roots, v_employees, v_profiles;

  IF v_roots IS DISTINCT FROM c_roots THEN
    RAISE EXCEPTION 'STOP: Dekret/Arkhiv roots differ: % (expected %)', v_roots, c_roots;
  END IF;
  IF v_employees <> 25 THEN
    RAISE EXCEPTION 'STOP: % not fired employees in Dekret/Arkhiv (expected 25) - review who becomes inactive', v_employees;
  END IF;
  IF v_profiles IS DISTINCT FROM c_profiles THEN
    RAISE EXCEPTION 'STOP: logins in Dekret/Arkhiv differ: % (expected %) - review who loses the portal', v_profiles, c_profiles;
  END IF;

  UPDATE user_profiles SET can_manage_staff_inactive = true
   WHERE id = c_chepikov AND can_manage_staff_inactive IS DISTINCT FROM true;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'can_manage_staff_inactive set: % row(s) (0 = already set)', v_count;

  UPDATE user_profiles SET login_when_staff_inactive = true
   WHERE id = c_housing AND login_when_staff_inactive IS DISTINCT FROM true;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'login_when_staff_inactive set: % row(s) (0 = already set)', v_count;
END
$fix$;

SELECT id, employee_id, can_manage_staff_inactive, login_when_staff_inactive
  FROM user_profiles
 WHERE can_manage_staff_inactive OR login_when_staff_inactive
 ORDER BY employee_id;

\echo 'Expected: exactly 2 rows -'
\echo '  employee 2063  (a51b9047-...) can_manage_staff_inactive = t, login_when_staff_inactive = f'
\echo '  employee 15745 (a4568fc6-...) can_manage_staff_inactive = f, login_when_staff_inactive = t'
\echo 'If so type COMMIT; otherwise ROLLBACK;'
