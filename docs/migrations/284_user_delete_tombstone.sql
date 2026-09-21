-- 284_user_delete_tombstone.sql
--
-- Удаление пользователя (DELETE /api/admin/users/:id) падало с 500: FK на
-- user_profiles/app_auth.users объявляются без ON DELETE, то есть с NO ACTION,
-- и блокируют каскад (23503). Миграция 097 починила это разово, снимком: всё,
-- что добавили позже (cancelled_by, leave_request_history, hiring_*,
-- contractor_*), снова блокирует. Обратная сторона 097 — CASCADE там, где
-- строка принадлежит не пользователю, а компании: удаление согласующего унесло
-- бы заявки, согласования табелей, расчётные листки, документы и аудит.
--
-- Политика (проверяется `npm run audit:user-fk`):
--   own       — строка принадлежит самой учётке        -> ON DELETE CASCADE
--   author    — строка принадлежит компании, поле хранит автора/действующего
--               -> ON DELETE SET DEFAULT на надгробный профиль
--   keep_null — ссылка не показывается как автор       -> ON DELETE SET NULL
--
-- SET DEFAULT вместо SET NULL выбран, чтобы интерфейс не менялся: на месте ФИО
-- остаётся «Удалённый пользователь», а не пустое «—», NOT NULL нигде не
-- снимается и типы API остаются прежними.
--
-- Идемпотентно: колонки с уже правильной политикой не трогаются; отсутствующие
-- в этой БД таблицы и колонки пропускаются.
--
-- Применение: через runner (`scripts/deploy-server.sh migrate`).

BEGIN;

-- 1. Надгробный профиль. Профиль без app_auth.users невозможен (FK
--    user_profiles_id_fkey_app_auth), поэтому создаётся пара. Вход закрыт
--    флагом is_disabled (local-auth.service.ts) и невалидным хешем пароля.
INSERT INTO app_auth.users (id, email, password_hash, is_disabled)
VALUES ('00000000-0000-0000-0000-00000000dead'::uuid, 'deleted-user@fot.local', '!disabled', true)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE v_role uuid;
BEGIN
  SELECT COALESCE(
    (SELECT id FROM public.system_roles WHERE code = 'worker' LIMIT 1),
    (SELECT id FROM public.system_roles WHERE is_admin = false ORDER BY code LIMIT 1),
    (SELECT id FROM public.system_roles ORDER BY code LIMIT 1)
  ) INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'справочник system_roles пуст — надгробному профилю нечего присвоить в system_role_id';
  END IF;
  INSERT INTO public.user_profiles (id, full_name, is_approved, system_role_id)
  VALUES ('00000000-0000-0000-0000-00000000dead'::uuid, 'Удалённый пользователь', false, v_role)
  ON CONFLICT (id) DO NOTHING;
END $$;

-- 2. Политика по колонкам.
CREATE TEMP TABLE _fk_policy(tbl text, col text, tgt text, kind text) ON COMMIT DROP;

INSERT INTO _fk_policy(tbl, col, tgt, kind) VALUES
  -- own: строка принадлежит самой учётке и уходит вместе с ней
  ('chat_contact_grants', 'user_a_id', 'public.user_profiles', 'own'),
  ('chat_contact_grants', 'user_b_id', 'public.user_profiles', 'own'),
  ('chat_contact_requests', 'requester_id', 'public.user_profiles', 'own'),
  ('chat_contact_requests', 'target_user_id', 'public.user_profiles', 'own'),
  ('chat_participants', 'user_id', 'public.user_profiles', 'own'),
  ('contractor_activation_batches', 'created_by', 'public.user_profiles', 'own'),
  ('contractor_org_access', 'user_id', 'public.user_profiles', 'own'),
  ('employee_hr_drafts', 'created_by', 'public.user_profiles', 'own'),
  ('push_subscriptions', 'user_id', 'app_auth.users', 'own'),
  ('timekeeper_folder_access', 'timekeeper_user_id', 'public.user_profiles', 'own'),
  ('timekeeper_object_access', 'timekeeper_user_id', 'public.user_profiles', 'own'),
  ('timesheet_reminder_log', 'user_id', 'public.user_profiles', 'own'),
  ('timesheet_responsibles', 'user_id', 'public.user_profiles', 'own'),
  ('user_company_access', 'user_id', 'public.user_profiles', 'own'),
  ('user_employee_access', 'user_id', 'public.user_profiles', 'own'),
  ('user_profiles', 'id', 'app_auth.users', 'own'),
  -- keep_null: ссылка не показывается как автор
  ('adaptive_test_sessions', 'user_id', 'public.user_profiles', 'keep_null'),
  ('user_profiles', 'approved_by', 'app_auth.users', 'keep_null'),
  ('user_profiles', 'supervisor_id', 'public.user_profiles', 'keep_null'),
  -- author: строка принадлежит компании, поле хранит автора/действующего
  ('adaptive_skill_profiles', 'created_by', 'public.user_profiles', 'author'),
  ('adaptive_skill_profiles', 'skill_md_uploaded_by', 'public.user_profiles', 'author'),
  ('attendance_adjustments', 'approved_by', 'public.user_profiles', 'author'),
  ('attendance_adjustments', 'created_by', 'public.user_profiles', 'author'),
  ('attendance_adjustments', 'updated_by', 'public.user_profiles', 'author'),
  ('audit_logs', 'user_id', 'app_auth.users', 'author'),
  ('chat_contact_grants', 'created_by', 'public.user_profiles', 'author'),
  ('chat_contact_requests', 'resolved_by', 'public.user_profiles', 'author'),
  ('chat_messages', 'sender_id', 'public.user_profiles', 'author'),
  ('contractor_org_access', 'created_by', 'public.user_profiles', 'author'),
  ('contractor_pass_document_history', 'changed_by', 'public.user_profiles', 'author'),
  ('contractor_pass_holders', 'approved_by', 'public.user_profiles', 'author'),
  ('contractor_pass_holders', 'changed_by', 'public.user_profiles', 'author'),
  ('contractor_passes', 'created_by', 'public.user_profiles', 'author'),
  ('contractor_roster', 'created_by', 'public.user_profiles', 'author'),
  ('contractor_submission_decisions', 'decided_by', 'public.user_profiles', 'author'),
  ('contractor_submissions', 'reviewed_by', 'public.user_profiles', 'author'),
  ('contractor_submissions', 'submitted_by', 'public.user_profiles', 'author'),
  ('data_api_keys', 'created_by', 'public.user_profiles', 'author'),
  ('department_object_assignment', 'created_by', 'public.user_profiles', 'author'),
  ('documents', 'uploaded_by', 'public.user_profiles', 'author'),
  ('employee_assignments', 'created_by', 'app_auth.users', 'author'),
  ('employee_department_access', 'created_by', 'public.user_profiles', 'author'),
  ('employee_direct_reports', 'assigned_by', 'public.user_profiles', 'author'),
  ('employee_hr_ocr_conflicts', 'resolved_by', 'public.user_profiles', 'author'),
  ('employee_hr_profile_history', 'changed_by', 'public.user_profiles', 'author'),
  ('employee_hr_profiles', 'created_by', 'public.user_profiles', 'author'),
  ('employee_hr_profiles', 'updated_by', 'public.user_profiles', 'author'),
  ('employee_hr_profiles', 'zup_exported_by', 'public.user_profiles', 'author'),
  ('employee_hr_profiles', 'zup_marked_by', 'public.user_profiles', 'author'),
  ('employee_object_assignment', 'created_by', 'public.user_profiles', 'author'),
  ('employee_object_attribution', 'created_by', 'app_auth.users', 'author'),
  ('employee_skud_object_access', 'created_by', 'app_auth.users', 'author'),
  ('employee_staff_comments', 'updated_by', 'public.user_profiles', 'author'),
  ('hiring_candidates', 'approved_by', 'public.user_profiles', 'author'),
  ('hiring_candidates', 'created_by', 'public.user_profiles', 'author'),
  ('hiring_candidates', 'verdict_by', 'public.user_profiles', 'author'),
  ('hiring_recruiters', 'added_by', 'public.user_profiles', 'author'),
  ('hiring_request_assignees', 'assigned_by', 'public.user_profiles', 'author'),
  ('hiring_request_events', 'author_user_id', 'public.user_profiles', 'author'),
  ('hiring_request_files', 'uploaded_by', 'public.user_profiles', 'author'),
  ('hiring_requests', 'author_user_id', 'public.user_profiles', 'author'),
  ('hr_profile_import_staging', 'linked_by', 'public.user_profiles', 'author'),
  ('kpi_premium_scale_versions', 'created_by', 'public.user_profiles', 'author'),
  ('kpi_premium_scale_versions', 'updated_by', 'public.user_profiles', 'author'),
  ('leave_request_history', 'actor_id', 'public.user_profiles', 'author'),
  ('leave_requests', 'cancelled_by', 'public.user_profiles', 'author'),
  ('leave_requests', 'hr_acknowledged_by', 'public.user_profiles', 'author'),
  ('leave_requests', 'reviewer_id', 'public.user_profiles', 'author'),
  ('newdb_checks', 'created_by', 'public.user_profiles', 'author'),
  ('object_contract_addenda', 'created_by', 'public.user_profiles', 'author'),
  ('object_contract_addenda', 'updated_by', 'public.user_profiles', 'author'),
  ('object_contracts', 'created_by', 'public.user_profiles', 'author'),
  ('object_contracts', 'updated_by', 'public.user_profiles', 'author'),
  ('object_kpi_assignments', 'created_by', 'public.user_profiles', 'author'),
  ('object_kpi_assignments', 'updated_by', 'public.user_profiles', 'author'),
  ('object_kpi_global_roles', 'created_by', 'public.user_profiles', 'author'),
  ('object_kpi_global_roles', 'updated_by', 'public.user_profiles', 'author'),
  ('object_kpi_history', 'changed_by', 'public.user_profiles', 'author'),
  ('object_kpi_month_plans', 'fixed_by', 'public.user_profiles', 'author'),
  ('object_ks2_entries', 'created_by', 'public.user_profiles', 'author'),
  ('object_ks2_entries', 'updated_by', 'public.user_profiles', 'author'),
  ('object_ks6_entries', 'created_by', 'public.user_profiles', 'author'),
  ('object_ks6_entries', 'updated_by', 'public.user_profiles', 'author'),
  ('official_memos', 'reviewer_id', 'public.user_profiles', 'author'),
  ('patent_payment_receipts', 'reviewed_by', 'public.user_profiles', 'author'),
  ('patent_payment_receipts', 'verified_by', 'public.user_profiles', 'author'),
  ('payments', 'created_by', 'public.user_profiles', 'author'),
  ('payroll_compensation_terms', 'created_by', 'public.user_profiles', 'author'),
  ('payroll_settings', 'created_by', 'public.user_profiles', 'author'),
  ('payslips', 'created_by', 'public.user_profiles', 'author'),
  ('person_blacklist', 'created_by', 'public.user_profiles', 'author'),
  ('person_blacklist', 'removed_by', 'public.user_profiles', 'author'),
  ('person_blacklist_memos', 'deleted_by', 'public.user_profiles', 'author'),
  ('person_blacklist_memos', 'uploaded_by', 'public.user_profiles', 'author'),
  ('salary_history', 'created_by', 'app_auth.users', 'author'),
  ('salary_raise_requests', 'author_user_id', 'public.user_profiles', 'author'),
  ('skud_travel_segments', 'approved_by', 'public.user_profiles', 'author'),
  ('timekeeper_folder_access', 'created_by', 'public.user_profiles', 'author'),
  ('timekeeper_object_access', 'created_by', 'public.user_profiles', 'author'),
  ('timesheet_approval_events', 'actor_user_id', 'public.user_profiles', 'author'),
  ('timesheet_approvals', 'reviewed_by', 'public.user_profiles', 'author'),
  ('timesheet_approvals', 'submitted_by', 'public.user_profiles', 'author'),
  ('timesheet_approvals', 'unlocked_by', 'public.user_profiles', 'author'),
  ('timesheet_timekeeper_review', 'checked_by', 'public.user_profiles', 'author'),
  ('timesheet_versions', 'created_by', 'public.user_profiles', 'author'),
  ('user_company_access', 'created_by', 'public.user_profiles', 'author'),
  ('user_employee_access', 'created_by', 'app_auth.users', 'author'),
  ('weekend_approval_assignments', 'assigned_by', 'public.user_profiles', 'author'),
  ('weekend_approval_assignments', 'deactivated_by', 'public.user_profiles', 'author');

DO $$
DECLARE
  r         record;
  v_rel     regclass;
  v_attnum  smallint;
  v_con     text;
  v_del     "char";
  v_want    "char";
  v_default text;
  v_changed int := 0;
BEGIN
  FOR r IN SELECT * FROM _fk_policy ORDER BY tbl, col LOOP
    v_rel := to_regclass('public.' || quote_ident(r.tbl));
    CONTINUE WHEN v_rel IS NULL;

    SELECT a.attnum INTO v_attnum
      FROM pg_attribute a
     WHERE a.attrelid = v_rel AND a.attname = r.col AND NOT a.attisdropped;
    CONTINUE WHEN v_attnum IS NULL;

    SELECT c.conname, c.confdeltype INTO v_con, v_del
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid = v_rel
       AND c.confrelid = r.tgt::regclass
       AND c.conkey = ARRAY[v_attnum];
    CONTINUE WHEN v_con IS NULL;

    v_want := CASE r.kind WHEN 'own' THEN 'c' WHEN 'author' THEN 'd' ELSE 'n' END;

    -- author: DEFAULT обязан быть надгробием, иначе SET DEFAULT запишет NULL
    -- (а на NOT NULL-колонке удаление упрётся в 23502).
    IF r.kind = 'author' THEN
      SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
        FROM pg_attrdef d
       WHERE d.adrelid = v_rel AND d.adnum = v_attnum;
      IF v_default IS DISTINCT FROM '''00000000-0000-0000-0000-00000000dead''::uuid' THEN
        EXECUTE format(
          'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %L::uuid',
          r.tbl, r.col, '00000000-0000-0000-0000-00000000dead');
      END IF;
    END IF;

    CONTINUE WHEN v_del = v_want;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, v_con);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(id) ON DELETE %s',
      r.tbl, v_con, r.col, r.tgt,
      CASE v_want WHEN 'c' THEN 'CASCADE' WHEN 'd' THEN 'SET DEFAULT' ELSE 'SET NULL' END);
    v_changed := v_changed + 1;
    RAISE NOTICE '% : %.% -> %', r.kind, r.tbl, r.col, v_want;
  END LOOP;
  RAISE NOTICE 'изменено политик: %', v_changed;
END $$;

-- 3. Колонки, оставшиеся вне политики (появились после этой миграции) — только
--    предупреждение; жёсткая проверка живёт в `npm run audit:user-fk`.
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(format('%s.%s', t.relname, a.attname), ', ' ORDER BY t.relname, a.attname)
    INTO v_left
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f'
     AND c.confrelid IN ('public.user_profiles'::regclass, 'app_auth.users'::regclass)
     AND NOT EXISTS (
       SELECT 1 FROM _fk_policy p WHERE p.tbl = t.relname AND p.col = a.attname
     );
  IF v_left IS NOT NULL THEN
    RAISE WARNING 'FK вне политики (проверьте audit:user-fk): %', v_left;
  END IF;
END $$;

COMMIT;

-- Проверка (каждый запрос — 0 строк):
--   -- блокирующие политики
--   SELECT conrelid::regclass, conname FROM pg_constraint
--    WHERE contype='f' AND confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)
--      AND confdeltype IN ('a','r');
--   -- SET NULL на NOT NULL
--   SELECT c.conrelid::regclass, a.attname FROM pg_constraint c
--     JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
--    WHERE c.contype='f' AND c.confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)
--      AND c.confdeltype='n' AND a.attnotnull;
--   -- SET DEFAULT без надгробия в DEFAULT
--   SELECT c.conrelid::regclass, a.attname FROM pg_constraint c
--     JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
--    WHERE c.contype='f' AND c.confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)
--      AND c.confdeltype='d'
--      AND COALESCE((SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d
--                     WHERE d.adrelid=c.conrelid AND d.adnum=c.conkey[1]), '')
--          <> '''00000000-0000-0000-0000-00000000dead''::uuid';
