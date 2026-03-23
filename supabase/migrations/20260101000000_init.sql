-- ==============================================
-- Инициализация схемы БД для локального Supabase
-- ==============================================

-- ENUM
CREATE TYPE public.employee_position_type AS ENUM ('worker', 'header', 'admin', 'super_admin');

-- SEQUENCES
CREATE SEQUENCE IF NOT EXISTS audit_logs_id_seq;
CREATE SEQUENCE IF NOT EXISTS employees_id_seq;
CREATE SEQUENCE IF NOT EXISTS skud_access_point_settings_id_seq;
CREATE SEQUENCE IF NOT EXISTS skud_daily_summary_id_seq;
CREATE SEQUENCE IF NOT EXISTS skud_events_id_seq;
CREATE SEQUENCE IF NOT EXISTS tender_salary_history_id_seq;
CREATE SEQUENCE IF NOT EXISTS tender_timesheet_id_seq;

-- ==============================================
-- TABLES (в порядке зависимостей)
-- ==============================================

-- 1. organizations
CREATE TABLE IF NOT EXISTS public.organizations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    parent_organization_id uuid,
    name text,
    CONSTRAINT organizations_pkey PRIMARY KEY (id),
    CONSTRAINT organizations_parent_organization_id_fkey FOREIGN KEY (parent_organization_id) REFERENCES public.organizations(id)
);
COMMENT ON COLUMN public.organizations.parent_organization_id IS 'Головная организация (для иерархии подрядчиков)';

-- 2. system_roles
CREATE TABLE IF NOT EXISTS public.system_roles (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    code text NOT NULL,
    name text NOT NULL,
    description text,
    permissions jsonb DEFAULT '[]'::jsonb,
    level integer DEFAULT 0,
    is_active boolean DEFAULT true,
    is_system boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT system_roles_pkey PRIMARY KEY (id),
    CONSTRAINT system_roles_code_key UNIQUE (code)
);

-- 3. org_departments
CREATE TABLE IF NOT EXISTS public.org_departments (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    parent_id uuid,
    sigur_department_id integer,
    name text,
    description text,
    CONSTRAINT org_departments_pkey PRIMARY KEY (id),
    CONSTRAINT org_departments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
    CONSTRAINT org_departments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.org_departments(id)
);

-- 4. positions
CREATE TABLE IF NOT EXISTS public.positions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    category text,
    grade integer,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sigur_position_id integer,
    name text,
    CONSTRAINT positions_pkey PRIMARY KEY (id),
    CONSTRAINT positions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

-- 5. employees
CREATE TABLE IF NOT EXISTS public.employees (
    id integer NOT NULL DEFAULT nextval('employees_id_seq'::regclass),
    organization_id uuid NOT NULL,
    is_archived boolean DEFAULT false,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    org_department_id uuid,
    email text,
    sigur_employee_id integer,
    position_id uuid,
    employment_status text NOT NULL DEFAULT 'active'::text,
    department_locked boolean NOT NULL DEFAULT false,
    full_name text,
    last_name text,
    first_name text,
    middle_name text,
    current_salary numeric,
    birth_date text,
    hire_date text,
    country text,
    pension_number text,
    patent_issue_date text,
    patent_expiry_date text,
    CONSTRAINT employees_pkey PRIMARY KEY (id),
    CONSTRAINT employees_org_department_id_fkey FOREIGN KEY (org_department_id) REFERENCES public.org_departments(id),
    CONSTRAINT employees_position_id_fkey FOREIGN KEY (position_id) REFERENCES public.positions(id),
    CONSTRAINT tender_employees_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

-- 6. org_sites
CREATE TABLE IF NOT EXISTS public.org_sites (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    department_id uuid,
    code text,
    address text,
    manager_id integer,
    start_date date,
    planned_end_date date,
    status text DEFAULT 'active'::text,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    name text,
    description text,
    CONSTRAINT org_sites_pkey PRIMARY KEY (id),
    CONSTRAINT org_sites_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.org_departments(id),
    CONSTRAINT org_sites_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.employees(id),
    CONSTRAINT org_sites_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

-- 7. employee_assignments
CREATE TABLE IF NOT EXISTS public.employee_assignments (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    employee_id integer NOT NULL,
    org_department_id uuid,
    org_site_id uuid,
    position_id uuid,
    effective_from date NOT NULL,
    effective_to date,
    is_primary boolean DEFAULT true,
    assignment_type text DEFAULT 'main'::text,
    change_reason text,
    order_number text,
    order_date date,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT employee_assignments_pkey PRIMARY KEY (id),
    CONSTRAINT employee_assignments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id),
    CONSTRAINT employee_assignments_org_department_id_fkey FOREIGN KEY (org_department_id) REFERENCES public.org_departments(id),
    CONSTRAINT employee_assignments_org_site_id_fkey FOREIGN KEY (org_site_id) REFERENCES public.org_sites(id),
    CONSTRAINT employee_assignments_position_id_fkey FOREIGN KEY (position_id) REFERENCES public.positions(id),
    CONSTRAINT employee_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id)
);

-- 8. user_profiles
CREATE TABLE IF NOT EXISTS public.user_profiles (
    id uuid NOT NULL,
    full_name text,
    organization_id uuid,
    is_approved boolean DEFAULT false,
    approved_by uuid,
    approved_at timestamp with time zone,
    totp_secret text,
    recovery_codes text[],
    two_factor_enabled boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    position_type employee_position_type NOT NULL DEFAULT 'worker'::employee_position_type,
    employee_id integer,
    supervisor_id uuid,
    imported_position text,
    system_role_id uuid,
    reset_token text,
    reset_token_expires timestamp with time zone,
    CONSTRAINT user_profiles_pkey PRIMARY KEY (id),
    CONSTRAINT user_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id),
    CONSTRAINT user_profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
    CONSTRAINT user_profiles_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id),
    CONSTRAINT user_profiles_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id),
    CONSTRAINT user_profiles_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.user_profiles(id),
    CONSTRAINT user_profiles_system_role_id_fkey FOREIGN KEY (system_role_id) REFERENCES public.system_roles(id)
);

-- 9. audit_logs
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id integer NOT NULL DEFAULT nextval('audit_logs_id_seq'::regclass),
    user_id uuid NOT NULL,
    action character varying(50) NOT NULL,
    entity_type character varying(50),
    entity_id character varying(100),
    details jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
    CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);

-- 10. skud_access_point_settings
CREATE TABLE IF NOT EXISTS public.skud_access_point_settings (
    id bigint NOT NULL DEFAULT nextval('skud_access_point_settings_id_seq'::regclass),
    organization_id uuid NOT NULL,
    department_id uuid NOT NULL,
    access_point_name text NOT NULL,
    is_internal boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT skud_access_point_settings_pkey PRIMARY KEY (id),
    CONSTRAINT skud_access_point_settings_org_dept_ap_key UNIQUE (organization_id, department_id, access_point_name)
);

-- 11. skud_daily_summary
CREATE TABLE IF NOT EXISTS public.skud_daily_summary (
    id bigint NOT NULL DEFAULT nextval('skud_daily_summary_id_seq'::regclass),
    organization_id uuid NOT NULL,
    employee_id bigint NOT NULL,
    date date NOT NULL,
    first_entry time without time zone,
    last_exit time without time zone,
    total_hours numeric(5,2),
    is_present boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    break_hours numeric(5,2) DEFAULT 0,
    CONSTRAINT skud_daily_summary_pkey PRIMARY KEY (id),
    CONSTRAINT skud_daily_summary_org_emp_date_key UNIQUE (organization_id, employee_id, date),
    CONSTRAINT skud_daily_summary_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id),
    CONSTRAINT skud_daily_summary_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

-- 12. skud_events
CREATE TABLE IF NOT EXISTS public.skud_events (
    id bigint NOT NULL DEFAULT nextval('skud_events_id_seq'::regclass),
    organization_id uuid NOT NULL,
    event_date date NOT NULL,
    event_time time without time zone NOT NULL,
    access_point text,
    direction text,
    employee_id bigint,
    created_at timestamp with time zone DEFAULT now(),
    dedup_hash text,
    physical_person text,
    card_number text,
    CONSTRAINT skud_events_pkey PRIMARY KEY (id),
    CONSTRAINT uq_skud_events_dedup_hash UNIQUE (dedup_hash),
    CONSTRAINT skud_events_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id),
    CONSTRAINT skud_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

-- 13. skud_sync_department_filter
CREATE TABLE IF NOT EXISTS public.skud_sync_department_filter (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    sigur_department_id integer NOT NULL,
    sigur_department_name text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT skud_sync_department_filter_pkey PRIMARY KEY (id),
    CONSTRAINT skud_sync_department_filter_org_sigur_key UNIQUE (organization_id, sigur_department_id),
    CONSTRAINT skud_sync_department_filter_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

-- 14. skud_sync_employee_filter
CREATE TABLE IF NOT EXISTS public.skud_sync_employee_filter (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    sigur_employee_id integer NOT NULL,
    sigur_employee_name text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT skud_sync_employee_filter_pkey PRIMARY KEY (id),
    CONSTRAINT skud_sync_employee_filter_org_sigur_key UNIQUE (organization_id, sigur_employee_id),
    CONSTRAINT skud_sync_employee_filter_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

-- 15. tender_salary_history
CREATE TABLE IF NOT EXISTS public.tender_salary_history (
    id integer NOT NULL DEFAULT nextval('tender_salary_history_id_seq'::regclass),
    employee_id integer NOT NULL,
    effective_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    change_reason text,
    order_number text,
    order_date date,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now(),
    salary numeric,
    note text,
    CONSTRAINT tender_salary_history_pkey PRIMARY KEY (id),
    CONSTRAINT tender_salary_history_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id),
    CONSTRAINT tender_salary_history_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id)
);

-- 16. tender_timesheet
CREATE TABLE IF NOT EXISTS public.tender_timesheet (
    id integer NOT NULL DEFAULT nextval('tender_timesheet_id_seq'::regclass),
    employee_id integer NOT NULL,
    work_date date NOT NULL,
    status character varying(10) NOT NULL,
    hours_worked numeric(4,2),
    is_correction boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT tender_timesheet_pkey PRIMARY KEY (id),
    CONSTRAINT tender_timesheet_emp_date_key UNIQUE (employee_id, work_date),
    CONSTRAINT tender_timesheet_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id)
);

-- ==============================================
-- FUNCTIONS
-- ==============================================

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recalculate_skud_daily_summary(p_organization_id uuid, p_employee_id bigint, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_first_entry TIME;
    v_last_exit TIME;
    v_total_seconds DECIMAL := 0;
    v_break_seconds DECIMAL := 0;
    v_total_hours DECIMAL(5,2);
    v_break_hours DECIMAL(5,2);
    v_prev_exit TIME := NULL;
    v_rec RECORD;
BEGIN
    SELECT event_time INTO v_first_entry
    FROM skud_events e
    WHERE e.organization_id = p_organization_id
      AND e.employee_id = p_employee_id
      AND e.event_date = p_date
      AND e.direction = 'entry'
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.organization_id = p_organization_id
          AND s.access_point_name = e.access_point
          AND s.is_internal = true
      )
    ORDER BY event_time ASC
    LIMIT 1;

    SELECT event_time INTO v_last_exit
    FROM skud_events e
    WHERE e.organization_id = p_organization_id
      AND e.employee_id = p_employee_id
      AND e.event_date = p_date
      AND e.direction = 'exit'
      AND NOT EXISTS (
        SELECT 1 FROM skud_access_point_settings s
        WHERE s.organization_id = p_organization_id
          AND s.access_point_name = e.access_point
          AND s.is_internal = true
      )
    ORDER BY event_time DESC
    LIMIT 1;

    FOR v_rec IN
        SELECT event_time, direction
        FROM skud_events e
        WHERE e.organization_id = p_organization_id
          AND e.employee_id = p_employee_id
          AND e.event_date = p_date
          AND NOT EXISTS (
            SELECT 1 FROM skud_access_point_settings s
            WHERE s.organization_id = p_organization_id
              AND s.access_point_name = e.access_point
              AND s.is_internal = true
          )
        ORDER BY event_time ASC
    LOOP
        IF v_rec.direction = 'entry' THEN
            IF v_prev_exit IS NOT NULL THEN
                v_break_seconds := v_break_seconds + EXTRACT(EPOCH FROM (v_rec.event_time - v_prev_exit));
            END IF;
            v_prev_exit := NULL;
        ELSIF v_rec.direction = 'exit' THEN
            v_prev_exit := v_rec.event_time;
        END IF;
    END LOOP;

    IF v_first_entry IS NOT NULL AND v_last_exit IS NOT NULL AND v_last_exit > v_first_entry THEN
        v_total_seconds := EXTRACT(EPOCH FROM (v_last_exit - v_first_entry)) - v_break_seconds;
        v_total_hours := GREATEST(v_total_seconds / 3600, 0);
        v_break_hours := v_break_seconds / 3600;
    ELSE
        v_total_hours := NULL;
        v_break_hours := 0;
    END IF;

    INSERT INTO skud_daily_summary (organization_id, employee_id, date, first_entry, last_exit, total_hours, break_hours, is_present)
    VALUES (p_organization_id, p_employee_id, p_date, v_first_entry, v_last_exit, v_total_hours, v_break_hours, v_first_entry IS NOT NULL)
    ON CONFLICT (organization_id, employee_id, date)
    DO UPDATE SET
        first_entry = EXCLUDED.first_entry,
        last_exit = EXCLUDED.last_exit,
        total_hours = EXCLUDED.total_hours,
        break_hours = EXCLUDED.break_hours,
        is_present = EXCLUDED.is_present,
        updated_at = NOW();
END;
$function$;

CREATE OR REPLACE FUNCTION public.batch_recalculate_skud_daily_summary(p_pairs jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_pair jsonb;
BEGIN
  FOR v_pair IN SELECT * FROM jsonb_array_elements(p_pairs)
  LOOP
    PERFORM recalculate_skud_daily_summary(
      (v_pair->>'org_id')::uuid,
      (v_pair->>'emp_id')::bigint,
      (v_pair->>'date')::date
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_update_employee_ids(p_event_ids bigint[], p_employee_ids bigint[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE skud_events
  SET employee_id = updates.emp_id
  FROM (
    SELECT unnest(p_event_ids) AS evt_id,
           unnest(p_employee_ids) AS emp_id
  ) AS updates
  WHERE skud_events.id = updates.evt_id
    AND skud_events.employee_id IS NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.find_skud_duplicate_ids()
 RETURNS TABLE(id bigint)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT se.id
  FROM public.skud_events se
  INNER JOIN (
    SELECT dedup_hash, MIN(se2.id) AS keep_id
    FROM public.skud_events se2
    WHERE se2.dedup_hash IS NOT NULL
    GROUP BY se2.dedup_hash
    HAVING COUNT(*) > 1
  ) dupes ON se.dedup_hash = dupes.dedup_hash AND se.id <> dupes.keep_id;
$function$;

CREATE OR REPLACE FUNCTION public.generate_link_code()
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
DECLARE
  new_code VARCHAR(12);
  exists_count INTEGER;
BEGIN
  LOOP
    new_code := 'FOT-' || (
      SELECT string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (random()*30)::int + 1, 1), '')
      FROM generate_series(1, 6)
    );
    SELECT COUNT(*) INTO exists_count FROM employee_link_codes WHERE code = new_code;
    IF exists_count = 0 THEN
      RETURN new_code;
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_subordinates(supervisor_uuid uuid)
 RETURNS TABLE(user_id uuid)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  WITH RECURSIVE subs AS (
    SELECT id FROM user_profiles WHERE supervisor_id = supervisor_uuid
    UNION ALL
    SELECT up.id FROM user_profiles up
    JOIN subs s ON up.supervisor_id = s.id
  )
  SELECT id FROM subs;
$function$;

-- ==============================================
-- INDEXES
-- ==============================================

-- audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs USING btree (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs USING btree (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON public.audit_logs USING btree (user_id);

-- employee_assignments
CREATE INDEX IF NOT EXISTS idx_assignments_current ON public.employee_assignments USING btree (employee_id) WHERE (effective_to IS NULL);
CREATE INDEX IF NOT EXISTS idx_assignments_department ON public.employee_assignments USING btree (org_department_id);
CREATE INDEX IF NOT EXISTS idx_assignments_employee ON public.employee_assignments USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_assignments_period ON public.employee_assignments USING btree (effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_assignments_position ON public.employee_assignments USING btree (position_id);
CREATE INDEX IF NOT EXISTS idx_assignments_site ON public.employee_assignments USING btree (org_site_id);

-- employees
CREATE INDEX IF NOT EXISTS idx_employees_active ON public.employees USING btree (organization_id, id) INCLUDE (full_name, org_department_id, position_id, sigur_employee_id, employment_status) WHERE ((is_archived = false) AND (employment_status = 'active'::text));
CREATE INDEX IF NOT EXISTS idx_employees_archived ON public.employees USING btree (is_archived);
CREATE INDEX IF NOT EXISTS idx_employees_department ON public.employees USING btree (org_department_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email ON public.employees USING btree (email) WHERE (email IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_sigur_id ON public.employees USING btree (sigur_employee_id) WHERE ((sigur_employee_id IS NOT NULL) AND (is_archived = false));
CREATE INDEX IF NOT EXISTS idx_tender_employees_organization ON public.employees USING btree (organization_id);

-- org_departments
CREATE INDEX IF NOT EXISTS idx_org_departments_org ON public.org_departments USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_departments_parent_id ON public.org_departments USING btree (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_departments_sigur_id ON public.org_departments USING btree (organization_id, sigur_department_id) WHERE (sigur_department_id IS NOT NULL);

-- org_sites
CREATE INDEX IF NOT EXISTS idx_org_sites_department ON public.org_sites USING btree (department_id);
CREATE INDEX IF NOT EXISTS idx_org_sites_manager ON public.org_sites USING btree (manager_id);
CREATE INDEX IF NOT EXISTS idx_org_sites_organization ON public.org_sites USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_sites_status ON public.org_sites USING btree (status) WHERE (is_active = true);

-- organizations
CREATE INDEX IF NOT EXISTS idx_organizations_parent_id ON public.organizations USING btree (parent_organization_id);

-- positions
CREATE INDEX IF NOT EXISTS idx_positions_active ON public.positions USING btree (organization_id) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_positions_category ON public.positions USING btree (category);
CREATE INDEX IF NOT EXISTS idx_positions_organization ON public.positions USING btree (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_sigur_id ON public.positions USING btree (organization_id, sigur_position_id) WHERE (sigur_position_id IS NOT NULL);

-- skud_daily_summary
CREATE INDEX IF NOT EXISTS idx_skud_summary_employee ON public.skud_daily_summary USING btree (employee_id, date);
CREATE INDEX IF NOT EXISTS idx_skud_summary_org_date ON public.skud_daily_summary USING btree (organization_id, date);

-- skud_events
CREATE INDEX IF NOT EXISTS idx_skud_events_date_org_hash ON public.skud_events USING btree (event_date, organization_id) INCLUDE (dedup_hash) WHERE (dedup_hash IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_skud_events_employee ON public.skud_events USING btree (employee_id, event_date);
CREATE INDEX IF NOT EXISTS idx_skud_events_null_emp ON public.skud_events USING btree (organization_id, event_date, event_time DESC) WHERE (employee_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_skud_events_null_emp_id ON public.skud_events USING btree (id) WHERE (employee_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_skud_events_org_access_point ON public.skud_events USING btree (organization_id, access_point) WHERE (access_point IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_skud_events_org_date ON public.skud_events USING btree (organization_id, event_date);
CREATE INDEX IF NOT EXISTS idx_skud_events_org_date_time ON public.skud_events USING btree (organization_id, event_date DESC, event_time DESC) INCLUDE (employee_id, access_point, direction);

-- skud_sync_department_filter
CREATE INDEX IF NOT EXISTS idx_sync_dept_filter_org ON public.skud_sync_department_filter USING btree (organization_id);

-- skud_sync_employee_filter
CREATE INDEX IF NOT EXISTS idx_sync_emp_filter_org ON public.skud_sync_employee_filter USING btree (organization_id);

-- system_roles
CREATE INDEX IF NOT EXISTS idx_system_roles_code ON public.system_roles USING btree (code);
CREATE INDEX IF NOT EXISTS idx_system_roles_level ON public.system_roles USING btree (level);

-- tender_salary_history
CREATE INDEX IF NOT EXISTS idx_salary_history_created_by ON public.tender_salary_history USING btree (created_by);
CREATE INDEX IF NOT EXISTS idx_salary_history_date ON public.tender_salary_history USING btree (effective_date);
CREATE INDEX IF NOT EXISTS idx_salary_history_employee ON public.tender_salary_history USING btree (employee_id);

-- tender_timesheet
CREATE INDEX IF NOT EXISTS idx_timesheet_date ON public.tender_timesheet USING btree (work_date);
CREATE INDEX IF NOT EXISTS idx_timesheet_employee ON public.tender_timesheet USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_timesheet_status ON public.tender_timesheet USING btree (status);

-- user_profiles
CREATE INDEX IF NOT EXISTS idx_user_profiles_approved ON public.user_profiles USING btree (is_approved);
CREATE INDEX IF NOT EXISTS idx_user_profiles_employee ON public.user_profiles USING btree (employee_id) WHERE (employee_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_user_profiles_employee_id ON public.user_profiles USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_organization ON public.user_profiles USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_position_type ON public.user_profiles USING btree (position_type);
CREATE INDEX IF NOT EXISTS idx_user_profiles_supervisor_id ON public.user_profiles USING btree (supervisor_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_system_role ON public.user_profiles USING btree (system_role_id);

-- ==============================================
-- TRIGGERS
-- ==============================================

CREATE TRIGGER update_employee_assignments_updated_at BEFORE UPDATE ON public.employee_assignments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tender_employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_org_sites_updated_at BEFORE UPDATE ON public.org_sites FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_positions_updated_at BEFORE UPDATE ON public.positions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_system_roles_updated_at BEFORE UPDATE ON public.system_roles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tender_timesheet_updated_at BEFORE UPDATE ON public.tender_timesheet FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_profiles_updated_at BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
