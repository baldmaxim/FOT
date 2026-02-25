import { Response } from 'express';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { auditService } from '../services/audit.service.js';
import { structureController } from './structure.controller.js';
import { safeDecrypt } from '../utils/crypto.utils.js';
import { parseDate } from '../utils/date.utils.js';
import { parseFIO } from '../utils/fio.utils.js';
import { getOrgId } from '../utils/org.utils.js';
import type { AuthenticatedRequest, Employee, EmployeeEncrypted } from '../types/index.js';

// Интерфейс для запроса с файлом
interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

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
interface StructureCache {
  departments: Map<string, string>;
  positions: Map<string, string>;
}

/**
 * Загружает кэш структуры организации (отделы, должности)
 */
async function loadStructureCache(organizationId?: string): Promise<StructureCache> {
  const cache: StructureCache = {
    departments: new Map(),
    positions: new Map(),
  };

  let deptQuery = supabase.from('org_departments').select('id, name_encrypted');
  let posQuery = supabase.from('positions').select('id, name_encrypted');
  if (organizationId) {
    deptQuery = deptQuery.eq('organization_id', organizationId);
    posQuery = posQuery.eq('organization_id', organizationId);
  }

  const [departmentsRes, positionsRes] = await Promise.all([deptQuery, posQuery]);

  (departmentsRes.data || []).forEach((d: { id: string; name_encrypted: string }) => {
    cache.departments.set(d.id, safeDecrypt(d.name_encrypted) || '');
  });

  (positionsRes.data || []).forEach((p: { id: string; name_encrypted: string }) => {
    cache.positions.set(p.id, safeDecrypt(p.name_encrypted) || '');
  });

  return cache;
}

/**
 * Расшифровывает сотрудника из БД формата в API формат
 */
/**
 * Лёгкая расшифровка для списка — только full_name + lookup из кэша
 */
function decryptEmployeeList(encrypted: EmployeeEncrypted, structureCache: StructureCache): Employee {
  return {
    id: encrypted.id,
    organization_id: encrypted.organization_id,
    full_name: encryptionService.decrypt(encrypted.full_name_encrypted),
    full_name_encrypted: encrypted.full_name_encrypted,
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
    employment_status: encrypted.employment_status,
    department_locked: encrypted.department_locked,
    is_archived: encrypted.is_archived,
    archived_at: encrypted.archived_at,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

function decryptEmployee(encrypted: EmployeeEncrypted, structureCache: StructureCache): Employee {
  return {
    id: encrypted.id,
    organization_id: encrypted.organization_id,
    full_name: encryptionService.decrypt(encrypted.full_name_encrypted),
    full_name_encrypted: encrypted.full_name_encrypted,
    last_name: safeDecrypt(encrypted.last_name_encrypted),
    first_name: safeDecrypt(encrypted.first_name_encrypted),
    middle_name: safeDecrypt(encrypted.middle_name_encrypted),
    position_name: encrypted.position_id ? structureCache.positions.get(encrypted.position_id) || null : null,
    position_id: encrypted.position_id,
    current_salary: encrypted.current_salary_encrypted
      ? parseFloat(encryptionService.decrypt(encrypted.current_salary_encrypted))
      : null,
    birth_date: safeDecrypt(encrypted.birth_date_encrypted),
    hire_date: encryptionService.decrypt(encrypted.hire_date_encrypted),
    country: safeDecrypt(encrypted.country_encrypted),
    pension_number: safeDecrypt(encrypted.pension_number_encrypted),
    patent_issue_date: safeDecrypt(encrypted.patent_issue_date_encrypted),
    patent_expiry_date: safeDecrypt(encrypted.patent_expiry_date_encrypted),
    email: encrypted.email || null,
    department: encrypted.org_department_id ? structureCache.departments.get(encrypted.org_department_id) || null : null,
    org_department_id: encrypted.org_department_id,
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
      const departmentId = req.query.department_id as string | undefined;
      console.log(`[getAll] Start | archived=${showArchived} org=${organizationId} dept=${departmentId}`);

      // Пагинация Supabase (дефолт max-rows = 1000)
      const PAGE_SIZE = 1000;
      let allRows: EmployeeEncrypted[] = [];
      let from = 0;
      let hasMore = true;
      let pageNum = 0;

      while (hasMore) {
        const tPage = Date.now();
        let q = supabase
          .from('employees')
          .select('*')
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
        allRows = allRows.concat((data || []) as EmployeeEncrypted[]);
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
      const isListView = req.query.view === 'list';
      const decryptFn = isListView ? decryptEmployeeList : decryptEmployee;
      const employees = allRows.map(emp => decryptFn(emp, structureCache));
      console.log(`[getAll] Decrypt(${isListView ? 'light' : 'full'}) ${employees.length} employees in ${Date.now() - tDecrypt}ms`);

      const tAudit = Date.now();
      await auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
        details: { count: employees.length, archived: showArchived },
      });
      console.log(`[getAll] Audit log in ${Date.now() - tAudit}ms`);
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

      let q = supabase.from('employees').select('*').eq('id', id);
      if (organizationId) q = q.eq('organization_id', organizationId);

      const [employeeResult, structureCache] = await Promise.all([
        q.single(),
        loadStructureCache(organizationId || undefined),
      ]);

      if (employeeResult.error || !employeeResult.data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

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

      const encryptedData = {
        organization_id: organizationId,
        full_name_encrypted: encryptionService.encrypt(validated.full_name),
        last_name_encrypted: encryptionService.encrypt(fio.lastName),
        first_name_encrypted: fio.firstName ? encryptionService.encrypt(fio.firstName) : null,
        middle_name_encrypted: fio.middleName ? encryptionService.encrypt(fio.middleName) : null,
        current_salary_encrypted: validated.current_salary
          ? encryptionService.encrypt(String(validated.current_salary))
          : null,
        birth_date_encrypted: validated.birth_date
          ? encryptionService.encrypt(validated.birth_date)
          : null,
        hire_date_encrypted: encryptionService.encrypt(validated.hire_date),
        country_encrypted: validated.country
          ? encryptionService.encrypt(validated.country)
          : null,
        pension_number_encrypted: validated.pension_number
          ? encryptionService.encrypt(validated.pension_number)
          : null,
        patent_issue_date_encrypted: validated.patent_issue_date
          ? encryptionService.encrypt(validated.patent_issue_date)
          : null,
        patent_expiry_date_encrypted: validated.patent_expiry_date
          ? encryptionService.encrypt(validated.patent_expiry_date)
          : null,
        email: validated.email || null,
        org_department_id: validated.org_department_id || null,
        position_id: validated.position_id || null,
      };

      const { data, error } = await supabase
        .from('employees')
        .insert(encryptedData)
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
        updateData.full_name_encrypted = encryptionService.encrypt(validated.full_name);
        const fio = parseFIO(validated.full_name);
        updateData.last_name_encrypted = encryptionService.encrypt(fio.lastName);
        updateData.first_name_encrypted = fio.firstName ? encryptionService.encrypt(fio.firstName) : null;
        updateData.middle_name_encrypted = fio.middleName ? encryptionService.encrypt(fio.middleName) : null;
      }
      if (validated.current_salary !== undefined) {
        updateData.current_salary_encrypted = validated.current_salary
          ? encryptionService.encrypt(String(validated.current_salary))
          : null;
      }
      if (validated.birth_date !== undefined) {
        updateData.birth_date_encrypted = validated.birth_date
          ? encryptionService.encrypt(validated.birth_date)
          : null;
      }
      if (validated.hire_date !== undefined) {
        updateData.hire_date_encrypted = encryptionService.encrypt(validated.hire_date);
      }
      if (validated.country !== undefined) {
        updateData.country_encrypted = validated.country
          ? encryptionService.encrypt(validated.country)
          : null;
      }
      if (validated.pension_number !== undefined) {
        updateData.pension_number_encrypted = validated.pension_number
          ? encryptionService.encrypt(validated.pension_number)
          : null;
      }
      if (validated.patent_issue_date !== undefined) {
        updateData.patent_issue_date_encrypted = validated.patent_issue_date
          ? encryptionService.encrypt(validated.patent_issue_date)
          : null;
      }
      if (validated.patent_expiry_date !== undefined) {
        updateData.patent_expiry_date_encrypted = validated.patent_expiry_date
          ? encryptionService.encrypt(validated.patent_expiry_date)
          : null;
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

  /**
   * POST /api/employees/:id/archive
   */
  async archive(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      const { data, error } = await supabase
        .from('employees')
        .update({ is_archived: true, archived_at: new Date().toISOString() })
        .eq('id', id)
        .eq('organization_id', organizationId)
        .select()
        .single();

      if (error || !data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'ARCHIVE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
      });

      const structureCache = await loadStructureCache(organizationId);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Archive employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to archive employee' });
    }
  },

  /**
   * POST /api/employees/:id/restore
   */
  async restore(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      const { data, error } = await supabase
        .from('employees')
        .update({ is_archived: false, archived_at: null })
        .eq('id', id)
        .eq('organization_id', organizationId)
        .select()
        .single();

      if (error || !data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      const structureCache = await loadStructureCache(organizationId);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Restore employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to restore employee' });
    }
  },

  /**
   * GET /api/employees/:id/history
   */
  async getHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      // Проверяем что сотрудник принадлежит организации
      let empQ = supabase.from('employees').select('id').eq('id', id);
      if (organizationId) empQ = empQ.eq('organization_id', organizationId);

      const { data: emp } = await empQ.single();

      if (!emp) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      const { data, error } = await supabase
        .from('employee_history')
        .select('*')
        .eq('employee_id', id)
        .order('event_date', { ascending: false });

      if (error) {
        console.error('Get employee history error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch history' });
        return;
      }

      const structureCache = await loadStructureCache(organizationId || undefined);

      const events = (data || []).map((row: Record<string, unknown>) => {
        const eventData = row.event_data as Record<string, unknown> || {};
        let decryptedData: Record<string, unknown> = {};

        if (row.event_type === 'salary') {
          decryptedData = {
            salary: eventData.salary_encrypted ? parseFloat(safeDecrypt(eventData.salary_encrypted as string) || '0') : null,
            reason: eventData.reason,
            order_number: eventData.order_number,
            note: eventData.note ? safeDecrypt(eventData.note as string) : null,
          };
        } else if (row.event_type === 'assignment') {
          decryptedData = {
            department: eventData.department_id ? structureCache.departments.get(eventData.department_id as string) || null : null,
            department_id: eventData.department_id,
            position: eventData.position_id ? structureCache.positions.get(eventData.position_id as string) || null : null,
            position_id: eventData.position_id,
            site_id: eventData.site_id,
            is_primary: eventData.is_primary,
            type: eventData.type,
            reason: eventData.reason,
            order_number: eventData.order_number,
          };
        }

        return {
          employee_id: row.employee_id,
          event_type: row.event_type,
          event_id: row.event_id,
          event_date: row.event_date,
          event_end_date: row.event_end_date,
          event_data: decryptedData,
          created_at: row.created_at,
          created_by: row.created_by,
        };
      });

      res.json({ success: true, data: events });
    } catch (error) {
      console.error('Get employee history error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch history' });
    }
  },

  /**
   * DELETE /api/employees/all
   */
  async deleteAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      const { count: beforeCount } = await supabase
        .from('employees')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', organizationId);

      const { error } = await supabase
        .from('employees')
        .delete()
        .eq('organization_id', organizationId);

      if (error) {
        console.error('Delete all employees error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete employees' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'DELETE_ALL_EMPLOYEES', {
        details: { deleted: beforeCount || 0 },
      });

      res.json({
        success: true,
        data: { deleted: beforeCount || 0 },
        message: `Удалено ${beforeCount || 0} сотрудников`,
      });
    } catch (error) {
      console.error('Delete all employees error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete employees' });
    }
  },

  /**
   * POST /api/employees/import
   * Импорт сотрудников из Excel
   * Колонки: ФИО, Отдел, Дата приёма, Дата рождения, ЗП, Страна, СНИЛС,
   * Дата выдачи патента, Дата окончания патента, Email
   */
  async import(req: MulterRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      const rows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        dateNF: 'yyyy-mm-dd',
      });

      if (rows.length === 0) {
        res.status(400).json({ success: false, error: 'Файл пуст' });
        return;
      }

      const startRow = isHeaderRow(rows[0]) ? 1 : 0;
      const dataRows = rows.slice(startRow);

      const errors: string[] = [];
      const employeesToInsert: Record<string, unknown>[] = [];
      const departmentCache = new Map<string, string>();

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const rowNum = startRow + i + 1;

        if (!row || row.length === 0 || !row[0]) continue;

        const fullName = String(row[0] || '').trim();
        const department = String(row[1] || '').trim() || null;
        const hireDateRaw = row[2];
        const birthDateRaw = row[3];
        const salaryRaw = row[4];
        const country = String(row[5] || '').trim() || null;
        const pensionNumber = String(row[6] || '').trim() || null;
        const patentIssueDateRaw = row[7];
        const patentExpiryDateRaw = row[8];
        const emailRaw = String(row[9] || '').trim() || null;

        const email = emailRaw && emailRaw.includes('@') ? emailRaw.toLowerCase() : null;

        if (!fullName || fullName.length < 2) {
          errors.push(`Строка ${rowNum}: некорректное ФИО`);
          continue;
        }

        const hireDate = parseDate(hireDateRaw);
        if (!hireDate) {
          errors.push(`Строка ${rowNum}: некорректная дата приёма`);
          continue;
        }

        const birthDate = parseDate(birthDateRaw);
        const patentIssueDate = parseDate(patentIssueDateRaw);
        const patentExpiryDate = parseDate(patentExpiryDateRaw);

        let salary: number | null = null;
        if (salaryRaw !== undefined && salaryRaw !== null && salaryRaw !== '') {
          const salaryStr = String(salaryRaw).replace(/[^\d.,]/g, '').replace(',', '.');
          const parsed = parseFloat(salaryStr);
          if (!isNaN(parsed) && parsed >= 0) salary = parsed;
        }

        let orgDepartmentId: string | null = null;
        if (department) {
          const cacheKey = department.toLowerCase();
          if (departmentCache.has(cacheKey)) {
            orgDepartmentId = departmentCache.get(cacheKey)!;
          } else {
            orgDepartmentId = await structureController.findOrCreateDepartment(organizationId, department, null);
            if (orgDepartmentId) departmentCache.set(cacheKey, orgDepartmentId);
          }
        }

        const fio = parseFIO(fullName);

        employeesToInsert.push({
          organization_id: organizationId,
          full_name_encrypted: encryptionService.encrypt(fullName),
          last_name_encrypted: encryptionService.encrypt(fio.lastName),
          first_name_encrypted: fio.firstName ? encryptionService.encrypt(fio.firstName) : null,
          middle_name_encrypted: fio.middleName ? encryptionService.encrypt(fio.middleName) : null,
          hire_date_encrypted: encryptionService.encrypt(hireDate),
          birth_date_encrypted: birthDate ? encryptionService.encrypt(birthDate) : null,
          current_salary_encrypted: salary !== null ? encryptionService.encrypt(String(salary)) : null,
          country_encrypted: country ? encryptionService.encrypt(country) : null,
          pension_number_encrypted: pensionNumber ? encryptionService.encrypt(pensionNumber) : null,
          patent_issue_date_encrypted: patentIssueDate ? encryptionService.encrypt(patentIssueDate) : null,
          patent_expiry_date_encrypted: patentExpiryDate ? encryptionService.encrypt(patentExpiryDate) : null,
          org_department_id: orgDepartmentId,
          email,
        });
      }

      if (employeesToInsert.length === 0) {
        res.status(400).json({ success: false, error: 'Нет данных для импорта', errors });
        return;
      }

      const { error: insertError } = await supabase.from('employees').insert(employeesToInsert);

      if (insertError) {
        console.error('Import insert error:', insertError);
        res.status(500).json({ success: false, error: 'Ошибка сохранения данных' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'IMPORT_EMPLOYEES', {
        details: { imported: employeesToInsert.length, errors: errors.length },
      });

      res.json({
        success: true,
        data: { imported: employeesToInsert.length, errors },
      });
    } catch (error) {
      console.error('Import employees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта' });
    }
  },

  /**
   * POST /api/employees/:id/fire — уволить сотрудника
   */
  async fire(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { data, error } = await supabase
        .from('employees')
        .update({ employment_status: 'fired' })
        .eq('id', id)
        .select()
        .single();

      if (error || !data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      // Закрываем все активные назначения при увольнении
      const today = new Date().toISOString().slice(0, 10);
      await supabase
        .from('employee_assignments')
        .update({ effective_to: today })
        .eq('employee_id', id)
        .is('effective_to', null);

      await auditService.logFromRequest(req, req.user.id, 'FIRE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
      });

      const structureCache = await loadStructureCache(data.organization_id);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Fire employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to fire employee' });
    }
  },

  /**
   * POST /api/employees/:id/rehire — восстановить на работу
   */
  async rehire(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { data, error } = await supabase
        .from('employees')
        .update({ employment_status: 'active' })
        .eq('id', id)
        .select()
        .single();

      if (error || !data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      // Создаём новое назначение при восстановлении
      const today = new Date().toISOString().slice(0, 10);
      await supabase
        .from('employee_assignments')
        .insert({
          employee_id: Number(id),
          org_department_id: data.org_department_id || null,
          org_company_id: data.org_company_id || null,
          position_id: data.position_id || null,
          effective_from: today,
          is_primary: true,
          assignment_type: 'main',
          change_reason: 'Восстановление на работу',
          created_by: req.user.id,
        });

      await auditService.logFromRequest(req, req.user.id, 'REHIRE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
      });

      const structureCache = await loadStructureCache(data.organization_id);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Rehire employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to rehire employee' });
    }
  },

  /**
   * POST /api/employees/:id/move-department — переместить в другой отдел
   */
  async moveDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { org_department_id } = req.body as { org_department_id: string };

      if (!org_department_id) {
        res.status(400).json({ success: false, error: 'org_department_id required' });
        return;
      }

      // Получаем текущие данные сотрудника для переноса в назначение
      const { data: empBefore } = await supabase
        .from('employees')
        .select('position_id, org_company_id')
        .eq('id', id)
        .single();

      const today = new Date().toISOString().slice(0, 10);

      // Закрываем все активные назначения
      await supabase
        .from('employee_assignments')
        .update({ effective_to: today })
        .eq('employee_id', id)
        .is('effective_to', null);

      // Создаём новое назначение с новым отделом
      await supabase
        .from('employee_assignments')
        .insert({
          employee_id: Number(id),
          org_department_id,
          org_company_id: empBefore?.org_company_id || null,
          position_id: empBefore?.position_id || null,
          effective_from: today,
          is_primary: true,
          assignment_type: 'main',
          change_reason: 'Перевод в другой отдел',
          created_by: req.user.id,
        });

      const { data, error } = await supabase
        .from('employees')
        .update({ org_department_id, department_locked: true })
        .eq('id', id)
        .select()
        .single();

      if (error || !data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
        entityType: 'employee',
        entityId: id,
        details: { org_department_id },
      });

      const structureCache = await loadStructureCache(data.organization_id);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Move department error:', error);
      res.status(500).json({ success: false, error: 'Failed to move employee' });
    }
  },
};

function isHeaderRow(row: (string | number | Date | null)[]): boolean {
  if (!row || row.length === 0) return false;
  const firstCell = String(row[0] || '').toLowerCase();
  return (
    firstCell.includes('фио') ||
    firstCell.includes('имя') ||
    firstCell.includes('name') ||
    firstCell === '№' ||
    firstCell === '#'
  );
}
