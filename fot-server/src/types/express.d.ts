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
        employee_id: number | null;
        department_id: string | null;
        is_approved: boolean;
        two_factor_enabled: boolean;
        two_factor_verified: boolean;
      };
    }
  }
}

export {};
