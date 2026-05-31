// Вид отдела: обычный отдел / бригада / объект.
// Группа бригад одного начальника образует «участок» на уровне UI.
export type OrgDepartmentKind = 'department' | 'brigade' | 'object';

export const ORG_DEPARTMENT_KINDS: readonly OrgDepartmentKind[] = ['department', 'brigade', 'object'];

export const ORG_DEPARTMENT_KIND_LABELS: Record<OrgDepartmentKind, string> = {
  department: 'Отдел',
  brigade: 'Бригада',
  object: 'Объект',
};

// Структура организации - Отдел
export interface OrgDepartment {
  id: string;
  parent_id: string | null;
  sigur_department_id: number | null;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  kind: OrgDepartmentKind;
  created_at: string;
  updated_at: string;
}

// Узел дерева отделов (рекурсивный)
export interface OrgDepartmentNode extends OrgDepartment {
  children: OrgDepartmentNode[];
  // true — узел сам по себе в scope пользователя; false — только контейнер-предок.
  // Отсутствует — считаем как `true` (бэк до раскатки фикса дропдауна отделов).
  in_scope?: boolean;
}

// Полная структура для дерева
export interface OrgStructureTree {
  departments: OrgDepartmentNode[];
}

// Ответ API структуры
export interface OrgStructureResponse {
  departments: OrgDepartmentNode[];
  stats: {
    departments: number;
    archive_department_id?: string | null;
  };
}

// Строительный участок
export interface OrgSite {
  id: string;
  department_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  address: string | null;
  manager_id: number | null;
  start_date: string | null;
  planned_end_date: string | null;
  status: 'planning' | 'active' | 'completed' | 'suspended';
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Справочник должностей
export interface Position {
  id: string;
  name: string;
  category: 'worker' | 'engineer' | 'manager' | 'admin' | 'other' | null;
  grade: number | null;
  sigur_position_id: number | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Тип назначения
export type AssignmentType = 'main' | 'secondary' | 'temp' | 'part_time';

// Назначение сотрудника
export interface EmployeeAssignment {
  id: string;
  employee_id: number;
  org_department_id: string | null;
  org_site_id: string | null;
  position_id: string | null;
  effective_from: string;
  effective_to: string | null;
  is_primary: boolean;
  assignment_type: AssignmentType;
  change_reason: string | null;
  order_number: string | null;
  order_date: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Назначение с расшифрованными названиями
export interface EmployeeAssignmentWithNames extends EmployeeAssignment {
  department_name: string | null;
  site_name: string | null;
  position_name: string | null;
  position_category: string | null;
}

// Input для создания назначения
export interface EmployeeAssignmentInput {
  org_department_id?: string | null;
  org_site_id?: string | null;
  position_id?: string | null;
  effective_from: string;
  is_primary?: boolean;
  assignment_type?: AssignmentType;
  change_reason?: string;
  order_number?: string;
  order_date?: string;
  notes?: string;
}

// Элемент дерева организационной структуры
export type OrgUnitType = 'department' | 'site';

export interface OrgStructureUnit {
  id: string;
  unit_type: OrgUnitType;
  name: string;
  description: string | null;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  employee_count: number;
}
