import { supabase } from '../config/database.js';
import type { Employee, EmployeeEncrypted } from '../types/index.js';

// Кэш для расшифрованных названий структуры
export interface StructureCache {
  departments: Map<string, string>;
  positions: Map<string, string>;
}

/**
 * Загружает кэш структуры организации (отделы, должности)
 * TTL 60с. Инвалидация через invalidateStructureCache() — после синхронизации Sigur
 * или перемещения сотрудника между отделами.
 */
const structureCacheStore = new Map<string, { data: StructureCache; expiresAt: number }>();
const STRUCTURE_CACHE_TTL_MS = 60_000;
const STRUCTURE_CACHE_KEY = '__global__';

export function invalidateStructureCache(): void {
  structureCacheStore.delete(STRUCTURE_CACHE_KEY);
}

export async function loadStructureCache(): Promise<StructureCache> {
  const now = Date.now();
  const cached = structureCacheStore.get(STRUCTURE_CACHE_KEY);

  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const cache: StructureCache = {
    departments: new Map(),
    positions: new Map(),
  };

  const deptQuery = supabase.from('org_departments').select('id, name');
  const posQuery = supabase.from('positions').select('id, name');

  const [departmentsRes, positionsRes] = await Promise.all([deptQuery, posQuery]);

  (departmentsRes.data || []).forEach((d: { id: string; name: string }) => {
    cache.departments.set(d.id, d.name || '');
  });

  (positionsRes.data || []).forEach((p: { id: string; name: string }) => {
    cache.positions.set(p.id, p.name || '');
  });

  structureCacheStore.set(STRUCTURE_CACHE_KEY, { data: cache, expiresAt: now + STRUCTURE_CACHE_TTL_MS });
  return cache;
}

const parseOptionalNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Лёгкая расшифровка для списка — только full_name + lookup из кэша
 */
export function decryptEmployeeList(encrypted: EmployeeEncrypted, structureCache: StructureCache): Employee {
  return {
    id: encrypted.id,
    full_name: encrypted.full_name || '',
    last_name: null,
    first_name: null,
    middle_name: null,
    position_name: encrypted.position_id ? structureCache.positions.get(encrypted.position_id) || null : null,
    position_id: encrypted.position_id,
    sigur_employee_id: encrypted.sigur_employee_id,
    current_salary: parseOptionalNumber(encrypted.current_salary),
    salary_actual: parseOptionalNumber(encrypted.salary_actual),
    salary_calculated: parseOptionalNumber(encrypted.salary_calculated),
    staff_units: parseOptionalNumber(encrypted.staff_units),
    birth_date: null,
    hire_date: encrypted.hire_date || '',
    country: null,
    pension_number: null,
    patent_issue_date: null,
    patent_expiry_date: null,
    email: encrypted.email || null,
    department: encrypted.org_department_id ? structureCache.departments.get(encrypted.org_department_id) || null : null,
    org_department_id: encrypted.org_department_id,
    tab_number: null,
    current_status: null,
    permit_expiry_date: null,
    registration_cat1: null,
    registration_cat4: null,
    doc_receipt_date: null,
    work_object: null,
    employment_status: encrypted.employment_status,
    department_locked: encrypted.department_locked,
    is_archived: encrypted.is_archived,
    archived_at: encrypted.archived_at,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
    work_category: encrypted.work_category ?? null,
    excluded_from_timesheet: Boolean(encrypted.excluded_from_timesheet ?? false),
    excluded_from_timesheet_at: encrypted.excluded_from_timesheet_at ?? null,
  };
}

/**
 * Расшифровывает сотрудника из БД формата в API формат
 */
export function decryptEmployee(encrypted: EmployeeEncrypted, structureCache: StructureCache): Employee {
  return {
    id: encrypted.id,
    full_name: encrypted.full_name || '',
    last_name: encrypted.last_name || null,
    first_name: encrypted.first_name || null,
    middle_name: encrypted.middle_name || null,
    position_name: encrypted.position_id ? structureCache.positions.get(encrypted.position_id) || null : null,
    position_id: encrypted.position_id,
    sigur_employee_id: encrypted.sigur_employee_id,
    current_salary: parseOptionalNumber(encrypted.current_salary),
    salary_actual: parseOptionalNumber(encrypted.salary_actual),
    salary_calculated: parseOptionalNumber(encrypted.salary_calculated),
    staff_units: parseOptionalNumber(encrypted.staff_units),
    birth_date: encrypted.birth_date || null,
    hire_date: encrypted.hire_date || '',
    country: encrypted.country || null,
    pension_number: encrypted.pension_number || null,
    patent_issue_date: encrypted.patent_issue_date || null,
    patent_expiry_date: encrypted.patent_expiry_date || null,
    email: encrypted.email || null,
    department: encrypted.org_department_id ? structureCache.departments.get(encrypted.org_department_id) || null : null,
    org_department_id: encrypted.org_department_id,
    tab_number: encrypted.tab_number || null,
    current_status: encrypted.current_status || null,
    permit_expiry_date: encrypted.permit_expiry_date || null,
    registration_cat1: encrypted.registration_cat1 || null,
    registration_cat4: encrypted.registration_cat4 || null,
    doc_receipt_date: encrypted.doc_receipt_date || null,
    work_object: encrypted.work_object || null,
    employment_status: encrypted.employment_status,
    department_locked: encrypted.department_locked,
    is_archived: encrypted.is_archived,
    archived_at: encrypted.archived_at,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
    work_category: encrypted.work_category ?? null,
  };
}
