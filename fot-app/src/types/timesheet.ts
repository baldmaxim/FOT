// Timesheet types
export type TimesheetStatus = 'work' | 'absent' | 'vacation' | 'sick' | 'business_trip' | 'dayoff' | 'remote' | 'unpaid' | 'manual';

export interface TimesheetEntry {
  id: number | null;
  employee_id: number;
  work_date: string;
  status: TimesheetStatus;
  hours_worked: number | null;
  is_correction: boolean;
  notes?: string | null;
  first_entry?: string | null;
  last_exit?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TimesheetStats {
  employeeCount: number;
  workingDays: number;
  normHours: number;
  actualHours: number;
  deviations: { late: number; absent: number; sick: number };
}

export interface TimesheetEmployee {
  id: number;
  full_name: string;
  position_id: string | null;
  position_name: string | null;
  org_department_id: string | null;
  employment_status: 'active' | 'fired';
}

export interface TimesheetResponse {
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  stats: TimesheetStats;
}
