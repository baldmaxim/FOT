import type { AssignmentType, EmployeeAssignmentWithNames } from './organization';

// Employee types
export interface Employee {
  id: number;
  full_name: string;
  full_name_encrypted?: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  position_name: string | null;
  position_id: string | null;
  sigur_employee_id: number | null;
  hire_date: string;
  birth_date: string | null;
  current_salary: number | null;
  salary_actual: number | null;
  salary_calculated: number | null;
  staff_units: number | null;
  country: string | null;
  pension_number: string | null;
  patent_issue_date: string | null;
  patent_expiry_date: string | null;
  email: string | null;
  department: string | null;
  org_department_id: string | null;
  tab_number: string | null;
  current_status: string | null;
  permit_expiry_date: string | null;
  registration_cat1: string | null;
  registration_cat4: string | null;
  doc_receipt_date: string | null;
  work_object: string | null;
  employment_status: 'active' | 'fired';
  department_locked: boolean;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  work_category: string | null;
  schedule_override_id?: string | null;
  schedule_override_name?: string | null;
  schedule_override_effective_from?: string | null;
  site_name?: string | null;
  site_manager_full_name?: string | null;
}

// Типы для обогащения сотрудников из Excel
export interface EnrichPreviewItem {
  id: number;
  fullName: string;
  updates: Record<string, { old: string | null; new: string | null }>;
}

export interface EnrichPreview {
  matched: EnrichPreviewItem[];
  unmatched: Array<{ fullName: string; department: string | null }>;
  ambiguous: Array<{ fullName: string; count: number }>;
  stats: { total: number; matched: number; unmatched: number; ambiguous: number };
}

export interface EnrichResult {
  updated: number;
  errors: string[];
}

export interface ConflictRow {
  id: number;
  fullName: string;
  existingEmail: string;
  newEmail: string;
}

export interface ContactsEnrichPreview extends EnrichPreview {
  conflicts: ConflictRow[];
  stats: { total: number; matched: number; conflicts: number; unmatched: number; ambiguous: number };
}

export interface EmployeeInput {
  full_name: string;
  hire_date: string;
  birth_date?: string | null;
  current_salary?: number | null;
  salary_actual?: number | null;
  salary_calculated?: number | null;
  staff_units?: number | null;
  country?: string | null;
  pension_number?: string | null;
  patent_issue_date?: string | null;
  patent_expiry_date?: string | null;
  email?: string | null;
  tab_number?: string | null;
  current_status?: string | null;
  permit_expiry_date?: string | null;
  registration_cat1?: string | null;
  registration_cat4?: string | null;
  doc_receipt_date?: string | null;
  work_object?: string | null;
  position_id?: string | null;
  org_department_id?: string | null;
}

// Расширенный Employee с текущими данными из VIEW
export interface EmployeeCurrent extends Employee {
  // Из employee_assignments
  assignment_id: string | null;
  assignment_from: string | null;
  assignment_type: AssignmentType | null;

  // Названия из справочников
  site: string | null;
  org_site_id: string | null;
  position_name: string | null;
  position_id: string | null;
  position_category: string | null;

  // Количество активных назначений
  active_assignments_count: number;

  // Все назначения (для множественных)
  all_assignments: EmployeeAssignmentWithNames[] | null;
}

// Событие истории сотрудника
export interface EmployeeHistoryEvent {
  employee_id: number;
  event_type: 'assignment' | 'salary';
  event_id: string;
  event_date: string;
  event_end_date: string | null;
  event_data: Record<string, unknown>;
  created_at: string;
  created_by: string | null;
}

// История зарплаты (расширенная)
export interface SalaryHistoryEntry {
  id: number;
  employee_id: number;
  salary: number;               // расшифрованная
  effective_date: string;
  note: string | null;
  change_reason: string | null;
  order_number: string | null;
  order_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}

// Input для создания записи зарплаты
export interface SalaryHistoryInput {
  salary: number;
  effective_date: string;
  note?: string;
  change_reason?: string;
  order_number?: string;
  order_date?: string;
}
