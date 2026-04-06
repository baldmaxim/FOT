import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { loadStructureCache, decryptEmployee, decryptEmployeeList } from '../services/employee-mapper.service.js';
import { parseFIO } from '../utils/fio.utils.js';
import { employeeChangesService } from '../services/employee-changes.service.js';
import type { AuthenticatedRequest, EmployeeEncrypted } from '../types/index.js';

// Импорт методов из подконтроллеров
import { archive, restore, fire, rehire, moveDepartment, getHistory, updateHistoryEvent, deleteHistoryEvent } from './employee-lifecycle.controller.js';
import { deleteAll } from './employee-import.controller.js';

// Схемы валидации
const createEmployeeSchema = z.object({
  full_name: z.string().min(2).max(255).trim(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  current_salary: z.number().min(0).max(999999999).nullable().optional(),
  salary_actual: z.number().min(0).max(999999999).nullable().optional(),
  salary_calculated: z.number().min(0).max(999999999).nullable().optional(),
  staff_units: z.number().min(0).max(1).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  pension_number: z.string().max(50).nullable().optional(),
  patent_issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  patent_expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  email: z.string().email().nullable().optional(),
  org_department_id: z.string().uuid().nullable().optional(),
  position_id: z.string().uuid().nullable().optional(),
});

const updateEmployeeSchema = createEmployeeSchema.partial();

export const employeesController = {
  /**
   * GET /api/employees
   * Поддерживает два режима:
   * 1) Legacy (без page) — грузит всё целиком
   * 2) Paginated (page=1&pageSize=50) — серверная пагинация с counts
   */
  async getAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const t0 = Date.now();
      const showArchived = req.query.archived === 'true';
      const departmentId = req.user.position_type === 'header' && req.user.department_id
        ? req.user.department_id
        : req.query.department_id as string | undefined;
      const isListView = req.query.view === 'list';
      const listColumns = 'id, full_name, position_id, email, org_department_id, employment_status, department_locked, is_archived, archived_at, created_at, updated_at';

      // --- Paginated mode ---
      const pageParam = req.query.page as string | undefined;
      if (pageParam) {
        const page = Math.max(1, parseInt(pageParam) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize as string) || 50));
        const search = (req.query.search as string || '').trim();
        const status = req.query.status as string | undefined; // 'active' | 'fired'
        const offset = (page - 1) * pageSize;

        // Main query with exact count
        let q = supabase
          .from('employees')
          .select(listColumns, { count: 'exact' })
          .eq('is_archived', showArchived)
          .order('full_name')
          .range(offset, offset + pageSize - 1);

        if (departmentId) q = q.eq('org_department_id', departmentId);
        if (search) q = q.ilike('full_name', `%${search}%`);
        if (status === 'fired') q = q.eq('employment_status', 'fired');
        else if (status === 'active' || !status) q = q.neq('employment_status', 'fired');

        const { data, error, count } = await q;
        if (error) {
          console.error('Get employees paginated error:', error);
          res.status(500).json({ success: false, error: 'Failed to fetch employees' });
          return;
        }

        const structureCache = await loadStructureCache();
        const employees = (data || []).map(emp => decryptEmployeeList(emp as unknown as EmployeeEncrypted, structureCache));
        const total = count ?? 0;

        // Counts query: dept counts + status counts (lightweight, без search/dept/status фильтров)
        let countsQuery = supabase
          .from('employees')
          .select('org_department_id, employment_status')
          .eq('is_archived', showArchived);

        const { data: countRows } = await countsQuery;
        const byDepartment: Record<string, number> = {};
        const byStatus = { active: 0, fired: 0 };
        for (const row of countRows || []) {
          const r = row as { org_department_id: string | null; employment_status: string };
          if (r.employment_status === 'fired') {
            byStatus.fired++;
          } else {
            byStatus.active++;
            if (r.org_department_id) {
              byDepartment[r.org_department_id] = (byDepartment[r.org_department_id] || 0) + 1;
            }
          }
        }

        auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
          details: { count: employees.length, page, archived: showArchived },
        }).catch((err: unknown) => console.error('[audit] VIEW_EMPLOYEES log failed:', err));

        console.log(`[getAll] Paginated page=${page} size=${pageSize} total=${total} in ${Date.now() - t0}ms`);
        res.json({
          success: true,
          data: employees,
          meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
          counts: { byDepartment, byStatus },
        });
        return;
      }

      // --- Legacy mode (без page) ---
      console.log(`[getAll] Legacy | archived=${showArchived} dept=${departmentId} list=${isListView}`);
      const INTERNAL_PAGE = 1000;
      let allRows: EmployeeEncrypted[] = [];
      let from = 0;
      let hasMore = true;

      while (hasMore) {
        let q = supabase
          .from('employees')
          .select(isListView ? listColumns : '*')
          .eq('is_archived', showArchived)
          .order('id')
          .range(from, from + INTERNAL_PAGE - 1);

        if (departmentId) q = q.eq('org_department_id', departmentId);

        const { data, error } = await q;
        if (error) {
          console.error('Get employees error:', error);
          res.status(500).json({ success: false, error: 'Failed to fetch employees' });
          return;
        }

        allRows = allRows.concat((data || []) as unknown as EmployeeEncrypted[]);
        hasMore = (data?.length || 0) === INTERNAL_PAGE;
        from += INTERNAL_PAGE;
      }

      const structureCache = await loadStructureCache();
      const decryptFn = isListView ? decryptEmployeeList : decryptEmployee;
      const employees = allRows.map(emp => decryptFn(emp, structureCache));

      auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
        details: { count: employees.length, archived: showArchived },
      }).catch((err: unknown) => console.error('[audit] VIEW_EMPLOYEES log failed:', err));
      console.log(`[getAll] Legacy total=${employees.length} in ${Date.now() - t0}ms`);

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

      const employeeResult = await supabase.from('employees').select('*').eq('id', id).single();

      if (employeeResult.error || !employeeResult.data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      const structureCache = await loadStructureCache();
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

      const fio = parseFIO(validated.full_name);

      const insertData = {
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

      const structureCache = await loadStructureCache();
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

      const { data: existing } = await supabase
        .from('employees')
        .select('id')
        .eq('id', id)
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

      const structureCache = await loadStructureCache();
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

      const { error } = await supabase
        .from('employees')
        .delete()
        .eq('id', id);

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

  // POST /api/employees/:id/change-salary
  async changeSalary(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { salary, reason, effective_date } = req.body as { salary: number; reason?: string; effective_date?: string };

      if (!salary || salary <= 0) {
        res.status(400).json({ success: false, error: 'salary is required and must be positive' });
        return;
      }

      await employeeChangesService.changeSalary(Number(id), salary, {
        reason,
        effectiveDate: effective_date,
        createdBy: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_SALARY', {
        entityType: 'employee',
        entityId: id,
        details: { salary, reason },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Change salary error:', error);
      res.status(500).json({ success: false, error: 'Failed to change salary' });
    }
  },

  // POST /api/employees/:id/change-position
  async changePosition(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { position_name, reason, effective_date } = req.body as { position_name: string; reason?: string; effective_date?: string };

      if (!position_name?.trim()) {
        res.status(400).json({ success: false, error: 'position_name is required' });
        return;
      }

      // Ищем или создаём должность
      const name = position_name.trim();
      let positionId: string;

      const { data: existing } = await supabase
        .from('positions')
        .select('id')
        .ilike('name', name)
        .limit(1)
        .single();

      if (existing) {
        positionId = existing.id;
      } else {
        const { data: created } = await supabase
          .from('positions')
          .insert({ name, is_active: true, sort_order: 0 })
          .select('id')
          .single();
        positionId = created!.id;
      }

      await employeeChangesService.changePosition(Number(id), positionId, {
        reason,
        effectiveDate: effective_date,
        createdBy: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
        details: { position_name: name, reason },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Change position error:', error);
      res.status(500).json({ success: false, error: 'Failed to change position' });
    }
  },

  // Методы из employee-lifecycle.controller.ts
  archive,
  restore,
  fire,
  rehire,
  moveDepartment,
  getHistory,
  updateHistoryEvent,
  deleteHistoryEvent,

  // Методы из employee-import.controller.ts
  deleteAll,
};
