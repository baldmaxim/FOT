// SKUD types
export interface SkudEvent {
  id: number;
  physical_person: string;
  card_number: string;
  event_time: string;
  event_date: string;
  access_point: string | null;
  direction: string | null;
}

export interface IEmployeePresence {
  employee_id: number;
  full_name: string;
  department_name: string | null;
  position_name: string | null;
  status: 'online' | 'offline' | 'unknown';
  since: string | null;
  first_entry: string | null;
  total_hours: number | null;
  exit_count: number;
  time_outside_minutes: number;
  last_access_point: string | null;
  punctuality_percent: number | null;
}

export interface SkudDailySummary {
  id: number;
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
}

export interface IAccessPointSetting {
  access_point_name: string;
  is_internal: boolean;
}
