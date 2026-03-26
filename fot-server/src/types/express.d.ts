import { EmployeePositionType } from './index.js';

declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        email: string;
        organization_id: string | null;
        position_type: EmployeePositionType;
        employee_id: number | null;
        department_id: string | null;
        is_approved: boolean;
        two_factor_enabled: boolean;
        two_factor_verified: boolean;
      };
    }
  }
}
