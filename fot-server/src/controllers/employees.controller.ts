import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { parseFIO } from '../utils/fio.utils.js';
import { getOrgId } from '../utils/org.utils.js';
import type { AuthenticatedRequest, Employee, EmployeeEncrypted } from '../types/index.js';

// Импорт методов из подконтроллеров
import { archive, restore, fire, rehire, moveDepartment, getHistory } from './employee-lifecycle.controller.js';
import { importEmployees, deleteAll } from './employee-import.controller.js';

// Схемы валидации
const createEmployeeSchema = z.object({
  full_name: z.string().min(2).max(255).trim(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  current_salary: z.number().min(0).max(999999999).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  pension_number: z.string().max(50).nullable().optional(),
  patent_issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  patent_expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  email: z.string().email().nullable().optional(),
  org_department_id: z.string().uuid().nullable().optional(),
  position_id: z.string().uuid().nullable().optional(),
});

const updateEmployeeSchema = createEmployeeSchema.partial();

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
const STRUCTURE_CACHE_TTL_MS = 60_000;

export async function loadStructureCache(organizationId?: string): Promise<StructureCache> {
  const cacheKey = organizationId || '__global__';
  const now = Date.now();
  const cached = structureCacheStore.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const cache: StructureCache = {
    departments: new Map(),
    positions: new Map(),
  };

  let deptQuery = supabase.from('org_departments').select('id, name');
  let posQuery = supabase.from('positions').select('id, name');
  if (organizationId) {
    deptQuery = deptQuery.eq('organization_id', organizationId);
    posQuery = posQuery.eq('organization_id', organizationId);
  }

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
function decryptEmployeeList(encrypted: EmployeeEncrypted, structureCache: StructureCache): Employee {
  return {
    id: encrypted.id,
    organization_id: encrypted.organization_id,
    full_name: encrypted.full_name || '',
    last_name: null,
    first_name: null,
    middle_name: null,
    position_name: encrypted.position_id ? structureCache.positions.get(encrypted.position_id) || null : null,
    position_id: encrypted.position_id,
    current_salary: null,
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
    organization_id: encrypted.organization_id,
    full_name: encrypted.full_name || '',
    last_name: encrypted.last_name || null,
    first_name: encrypted.first_name || null,
    middle_name: encrypted.middle_name || null,
    position_name: encrypted.position_id ? structureCache.positions.get(encrypted.position_id) || null : null,
    position_id: encrypted.position_id,
    current_salary: encrypted.current_salary ? parseFloat(encrypted.current_salary) : null,
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

export const employeesController = {
  /**
   * GET /api/employees
   */
  async getAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const t0 = Date.now();
      const showArchived = req.query.archived === 'true';
      const organizationId = req.user.organization_id;
      // Для header: принудительно фильтруем по его отделу
      const departmentId = req.user.position_type === 'header' && req.user.department_id
        ? req.user.department_id
        : req.query.department_id as string | undefined;
      const isListView = req.query.view === 'list';
      console.log(`[getAll] Start | archived=${showArchived} org=${organizationId} dept=${departmentId} list=${isListView}`);

      // Пагинация Supabase (дефолт max-rows = 1000)
      const PAGE_SIZE = 1000;
      let allRows: EmployeeEncrypted[] = [];
      let from = 0;
      let hasMore = true;
      let pageNum = 0;

      // Для list view выбираем только колонки, используемые decryptEmployeeList
      const listColumns = 'id, organization_id, full_name, position_id, email, org_department_id, employment_status, department_locked, is_archived, archived_at, created_at, updated_at';

      while (hasMore) {
        const tPage = Date.now();
        let q = supabase
          .from('employees')
          .select(isListView ? listColumns : '*')
          .eq('is_archived', showArchived)
          .order('id')
          .range(from, from + PAGE_SIZE - 1);

        if (organizationId) q = q.eq('organization_id', organizationId);
        if (departmentId) q = q.eq('org_department_id', departmentId);

        const { data, error } = await q;
        if (error) {
          console.error('Get employees error:', error);
          res.status(500).json({ success: false, error: 'Failed to fetch employees' });
          return;
        }

        console.log(`[getAll] Page ${pageNum}: ${data?.length || 0} rows in ${Date.now() - tPage}ms`);
        allRows = allRows.concat((data || []) as unknown as EmployeeEncrypted[]);
        hasMore = (data?.length || 0) === PAGE_SIZE;
        from += PAGE_SIZE;
        pageNum++;
      }

      const tDb = Date.now() - t0;
      console.log(`[getAll] DB total: ${allRows.length} rows in ${tDb}ms`);

      const tCache = Date.now();
      const structureCache = await loadStructureCache(organizationId || undefined);
      console.log(`[getAll] Structure cache: depts=${structureCache.departments.size} pos=${structureCache.positions.size} in ${Date.now() - tCache}ms`);

      const tDecrypt = Date.now();
      const decryptFn = isListView ? decryptEmployeeList : decryptEmployee;
      const employees = allRows.map(emp => decryptFn(emp, structureCache));
      console.log(`[getAll] Decrypt(${isListView ? 'light' : 'full'}) ${employees.length} employees in ${Date.now() - tDecrypt}ms`);

      auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
        details: { count: employees.length, archived: showArchived },
      }).catch(() => {});
      console.log(`[getAll] TOTAL: ${Date.now() - t0}ms`);

      res.json({ success: true, data: employees });
    } catch (error) {
      console.error('Get employees error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch employees' });
    }
  },

  /**
   * GET /api/employees/:id
   */
  async getById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      // Worker запрашивает свои данные — не фильтруем по организации
      const isSelfRequest = req.user.position_type === 'worker' &&
        req.user.employee_id !== null &&
        req.user.employee_id === parseInt(id, 10);

      let q = supabase.from('employees').select('*').eq('id', id);
      if (organizationId && !isSelfRequest) q = q.eq('organization_id', organizationId);

      const employeeResult = await q.single();

      if (employeeResult.error || !employeeResult.data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      // Для self-request используем фактический organization_id сотрудника для кэша структуры
      const effectiveOrgId = isSelfRequest
        ? (employeeResult.data.organization_id || organizationId || undefined)
        : (organizationId || undefined);

      const structureCache = await loadStructureCache(effectiveOrgId);
      const employee = decryptEmployee(employeeResult.data as EmployeeEncrypted, structureCache);
      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Get employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch employee' });
    }
  },

  /**
   * POST /api/employees
   */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const validated = createEmployeeSchema.parse(req.body);
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      const fio = parseFIO(validated.full_name);

      const insertData = {
        organization_id: organizationId,
        full_name: validated.full_name,
        last_name: fio.lastName,
        first_name: fio.firstName || null,
        middle_name: fio.middleName || null,
        current_salary: validated.current_salary ?? null,
        birth_date: validated.birth_date || null,
        hire_date: validated.hire_date,
        country: validated.country || null,
        pension_number: validated.pension_number || null,
        patent_issue_date: validated.patent_issue_date || null,
        patent_expiry_date: validated.patent_expiry_date || null,
        email: validated.email || null,
        org_department_id: validated.org_department_id || null,
        position_id: validated.position_id || null,
      };

      const { data, error } = await supabase
        .from('employees')
        .insert(insertData)
        .select()
        .single();

      if (error) {
        console.error('Create employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to create employee' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'CREATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: String(data.id),
      });

      const structureCache = await loadStructureCache(organizationId);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
      res.status(201).json({ success: true, data: employee });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Create employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to create employee' });
    }
  },

  /**
   * PUT /api/employees/:id
   */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const validated = updateEmployeeSchema.parse(req.body);
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      const { data: existing } = await supabase
        .from('employees')
        .select('id')
        .eq('id', id)
        .eq('organization_id', organizationId)
        .single();

      if (!existing) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (validated.full_name !== undefined) {
        updateData.full_name = validated.full_name;
        const fio = parseFIO(validated.full_name);
        updateData.last_name = fio.lastName;
        updateData.first_name = fio.firstName || null;
        updateData.middle_name = fio.middleName || null;
      }
      if (validated.current_salary !== undefined) {
        updateData.current_salary = validated.current_salary ?? null;
      }
      if (validated.birth_date !== undefined) {
        updateData.birth_date = validated.birth_date || null;
      }
      if (validated.hire_date !== undefined) {
        updateData.hire_date = validated.hire_date;
      }
      if (validated.country !== undefined) {
        updateData.country = validated.country || null;
      }
      if (validated.pension_number !== undefined) {
        updateData.pension_number = validated.pension_number || null;
      }
      if (validated.patent_issue_date !== undefined) {
        updateData.patent_issue_date = validated.patent_issue_date || null;
      }
      if (validated.patent_expiry_date !== undefined) {
        updateData.patent_expiry_date = validated.patent_expiry_date || null;
      }
      if (validated.email !== undefined) {
        updateData.email = validated.email;
      }
      if (validated.org_department_id !== undefined) {
        updateData.org_department_id = validated.org_department_id;
      }
      if (validated.position_id !== undefined) {
        updateData.position_id = validated.position_id;
      }

      const { data, error } = await supabase
        .from('employees')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error('Update employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to update employee' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
        details: { updated_fields: Object.keys(validated) },
      });

      const structureCache = await loadStructureCache(organizationId);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
      res.json({ success: true, data: employee });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to update employee' });
    }
  },

  /**
   * DELETE /api/employees/:id
   */
  async delete(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      const { error } = await supabase
        .from('employees')
        .delete()
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (error) {
        console.error('Delete employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete employee' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'DELETE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
      });

      res.json({ success: true, message: 'Employee deleted' });
    } catch (error) {
      console.error('Delete employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete employee' });
    }
  },

  // Методы из employee-lifecycle.controller.ts
  archive,
  restore,
  fire,
  rehire,
  moveDepartment,
  getHistory,

  // Методы из employee-import.controller.ts
  import: importEmployees,
  deleteAll,
};
