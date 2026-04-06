import { supabase } from '../config/database.js';
import type { Employee, EmployeeEncrypted } from '../types/index.js';

// Кэш для расшифрованных названий структуры
export interface StructureCache {
  departments: Map<string, string>;
  positions: Map<string, string>;
}

/**
 * Загружает кэш структуры организации (отделы, должности)
 * Кэшируется в памяти на 60 секунд для избежания повторных запросов
 */
const structureCacheStore = new Map<string, { data: StructureCache; expiresAt: number }>();
const STRUCTURE_CACHE_TTL_MS = 300_000;

export async function loadStructureCache(): Promise<StructureCache> {
  const cacheKey = '__global__';
  const now = Date.now();
  const cached = structureCacheStore.get(cacheKey);

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

  structureCacheStore.set(cacheKey, { data: cache, expiresAt: now + STRUCTURE_CACHE_TTL_MS });
  return cache;
}

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
    current_salary: null,
    salary_actual: null,
    salary_calculated: null,
    staff_units: null,
    birth_date: null,
    hire_date: '',
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
    current_salary: encrypted.current_salary ? parseFloat(encrypted.current_salary) : null,
    salary_actual: encrypted.salary_actual ? parseFloat(encrypted.salary_actual) : null,
    salary_calculated: encrypted.salary_calculated ? parseFloat(encrypted.salary_calculated) : null,
    staff_units: encrypted.staff_units ? parseFloat(encrypted.staff_units) : null,
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
  };
}
