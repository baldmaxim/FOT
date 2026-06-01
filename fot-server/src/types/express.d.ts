declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        email: string;
        system_role_id: string;
        role_code: string;
        is_admin: boolean;
        employee_variant: 'object' | 'office' | null;
        show_actual_hours: boolean;
        timesheet_months_back: number;
        timesheet_months_forward: number;
        timesheet_show_full_period: boolean;
        employee_id: number | null;
        department_id: string | null;
        is_approved: boolean;
        two_factor_enabled: boolean;
        two_factor_verified: boolean;
        company_scope?: { roots: 'all' | string[] };
        __company_subtree_ids?: string[];
        __manager_subtree_ids?: string[];
        __direct_subordinates?: Set<number>;
        __timekeeper_dept_seeds?: string[];
        __timekeeper_direct_employees?: Set<number>;
      };
    }
  }
}

export {};
