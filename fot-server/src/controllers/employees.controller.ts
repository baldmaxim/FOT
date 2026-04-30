import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { loadStructureCache, decryptEmployee, decryptEmployeeList } from '../services/employee-mapper.service.js';
import { employeeCache } from '../services/employee-cache.service.js';
import { getKnownArchiveDepartment, reconcileFiredEmployeesArchiveDepartment } from '../services/employee-archive-department.service.js';
import { parseFIO } from '../utils/fio.utils.js';
import { employeeChangesService } from '../services/employee-changes.service.js';
import {
  ensureSigurPosition,
  syncLinkedEmployeeFromSigur,
} from '../services/sigur-linked-employees.service.js';
import { sigurService } from '../services/sigur.service.js';
import { createSigurEmployee } from '../services/sigur-live-admin.service.js';
import { isProtectedArchiveDepartment } from '../services/employee-archive-department.service.js';
import type { AuthenticatedRequest, EmployeeEncrypted } from '../types/index.js';
import {
  canAccessEmployeeInScope,
  resolveManagedDepartmentIds,
  resolveRequestDataScope,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { collectDeptIds } from '../services/skud-shared.service.js';

// Полный список колонок employees для getById / lifecycle-хэндлеров
const EMPLOYEE_FULL_COLUMNS = 'id, full_name, last_name, first_name, middle_name, current_salary, salary_actual, salary_calculated, staff_units, birth_date, hire_date, country, pension_number, patent_issue_date, patent_expiry_date, email, org_department_id, position_id, sigur_employee_id, tab_number, current_status, permit_expiry_date, registration_cat1, registration_cat4, doc_receipt_date, work_object, employment_status, department_locked, is_archived, archived_at, created_at, updated_at';

// Кэш счётчиков /api/employees/counts (TTL 60с)
interface ICountsPayload { byDepartment: Record<string, number>; byStatus: { active: number; fired: number } }
const countsCache = new Map<string, { data: ICountsPayload; expiresAt: number }>();
const COUNTS_TTL_MS = 60_000;

// Импорт методов из подконтроллеров
import { archive, restore, fire, rehire, moveDepartment, batchMoveEmployees, getHistory, updateHistoryEvent, deleteHistoryEvent } from './employee-lifecycle.controller.js';
import { deleteAll } from './employee-import.controller.js';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Полная схема для PUT-апдейтов (все поля опциональны)
const fullEmployeeSchema = z.object({
  full_name: z.string().min(2).max(255).trim(),
  hire_date: z.string().regex(ISO_DATE_REGEX),
  birth_date: z.string().regex(ISO_DATE_REGEX).nullable().optional(),
  current_salary: z.number().min(0).max(999999999).nullable().optional(),
  salary_actual: z.number().min(0).max(999999999).nullable().optional(),
  salary_calculated: z.number().min(0).max(999999999).nullable().optional(),
  staff_units: z.number().min(0).max(1).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  pension_number: z.string().max(50).nullable().optional(),
  patent_issue_date: z.string().regex(ISO_DATE_REGEX).nullable().optional(),
  patent_expiry_date: z.string().regex(ISO_DATE_REGEX).nullable().optional(),
  email: z.string().email().nullable().optional(),
  tab_number: z.string().max(100).nullable().optional(),
  current_status: z.string().max(255).nullable().optional(),
  permit_expiry_date: z.string().regex(ISO_DATE_REGEX).nullable().optional(),
  registration_cat1: z.string().max(255).nullable().optional(),
  registration_cat4: z.string().max(255).nullable().optional(),
  doc_receipt_date: z.string().regex(ISO_DATE_REGEX).nullable().optional(),
  work_object: z.string().max(255).nullable().optional(),
  org_department_id: z.string().uuid().nullable().optional(),
  position_id: z.string().uuid().nullable().optional(),
});

// Схема для POST /api/employees — приём на работу через Sigur (минимальный набор).
// Остальные поля редактируются позже через PUT.
const createEmployeeSchema = z.object({
  full_name: z.string().min(2).max(255).trim(),
  hire_date: z.string().regex(ISO_DATE_REGEX),
  org_department_id: z.string().uuid(),
  position_id: z.string().uuid(),
  tab_number: z.string().max(100).nullable().optional(),
});

const updateEmployeeSchema = fullEmployeeSchema.partial();

async function resolveDepartmentFilterIds(departmentId: string | undefined | null): Promise<string[] | null> {
  if (!departmentId) return null;
  const ids = await collectDeptIds(departmentId);
  return ids.length > 0 ? ids : [departmentId];
}

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
      const scope = await resolveRequestDataScope(req);
      if (!scope) {
        res.status(403).json({ success: false, error: 'Data scope не настроен для роли' });
        return;
      }
      const showArchived = req.query.archived === 'true';
      const requestedDepartmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
      const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);
      const managedDepartmentIds = scope === 'department' && !requestedDepartmentId
        ? await resolveManagedDepartmentIds(req)
        : [];
      const departmentFilterIds = requestedDepartmentId
        ? await resolveDepartmentFilterIds(departmentId)
        : (managedDepartmentIds.length > 0 ? managedDepartmentIds : await resolveDepartmentFilterIds(departmentId));
      const isListView = req.query.view === 'list';
      const listColumns = 'id, full_name, position_id, email, org_department_id, employment_status, department_locked, is_archived, archived_at, created_at, updated_at, excluded_from_timesheet, excluded_from_timesheet_at';
      const staffColumns = listColumns + ', salary_actual, salary_calculated, current_salary';

      // --- Paginated mode ---
      const pageParam = req.query.page as string | undefined;
      if (pageParam) {
        const page = Math.max(1, parseInt(pageParam) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize as string) || 50));
        const search = (req.query.search as string || '').trim();
        const status = req.query.status as string | undefined; // 'active' | 'fired' | 'excluded'
        const offset = (page - 1) * pageSize;
        if (status === 'fired' && departmentId) {
          const archiveDepartment = await getKnownArchiveDepartment();
          if (archiveDepartment?.id === departmentId) {
            await reconcileFiredEmployeesArchiveDepartment(req.user.id);
          }
        }

        // Main query with exact count
        const selectCols = req.query.view === 'staff' ? staffColumns : listColumns;
        let q = supabase
          .from('employees')
          .select(selectCols, { count: 'exact' })
          .eq('is_archived', showArchived)
          .range(offset, offset + pageSize - 1);

        q = status === 'excluded'
          ? q.order('excluded_from_timesheet_at', { ascending: false })
          : q.order('full_name');

        if (scope === 'self') {
          if (!req.user.employee_id) {
            res.json({
              success: true,
              data: [],
              meta: { page, pageSize, total: 0, totalPages: 0 },
            });
            return;
          }
          q = q.eq('id', req.user.employee_id);
        } else if (departmentFilterIds?.length) {
          q = departmentFilterIds.length === 1
            ? q.eq('org_department_id', departmentFilterIds[0])
            : q.in('org_department_id', departmentFilterIds);
        }
        if (search) q = q.ilike('full_name', `%${search}%`);
        if (status === 'fired') q = q.eq('employment_status', 'fired');
        else if (status === 'excluded') q = q.eq('excluded_from_timesheet', true).neq('employment_status', 'fired');
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

        auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
          details: { count: employees.length, page, archived: showArchived },
        }).catch((err: unknown) => console.error('[audit] VIEW_EMPLOYEES log failed:', err));

        console.log(`[getAll] Paginated page=${page} size=${pageSize} total=${total} in ${Date.now() - t0}ms`);
        res.json({
          success: true,
          data: employees,
          meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
        });
        return;
      }

      // --- Legacy mode (без page) ---
      console.log(`[getAll] Legacy | archived=${showArchived} dept=${departmentId} list=${isListView}`);
      const INTERNAL_PAGE = 1000;
      let allRows: EmployeeEncrypted[] = [];
      let from = 0;
      let hasMore = true;

      const legacyColumns: string = isListView ? listColumns : EMPLOYEE_FULL_COLUMNS;
      while (hasMore) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = supabase
          .from('employees')
          .select(legacyColumns)
          .eq('is_archived', showArchived)
          .order('id')
          .range(from, from + INTERNAL_PAGE - 1);

        if (scope === 'self') {
          if (!req.user.employee_id) {
            break;
          }
          q = q.eq('id', req.user.employee_id);
        } else if (departmentFilterIds?.length) {
          q = departmentFilterIds.length === 1
            ? q.eq('org_department_id', departmentFilterIds[0])
            : q.in('org_department_id', departmentFilterIds);
        }

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
   * GET /api/employees/counts
   * Счётчики по отделам и статусам. Кэшируется на 60с — считается тяжёлым,
   * так как требует обхода всех строк employees.
   */
  async getCounts(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveRequestDataScope(req);
      if (!scope) {
        res.status(403).json({ success: false, error: 'Data scope не настроен для роли' });
        return;
      }
      const showArchived = req.query.archived === 'true';
      const cacheKey = `counts:${scope}:${req.user.id}:${showArchived ? 'archived' : 'active'}`;
      const cached = countsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.setHeader('Cache-Control', 'private, max-age=30');
        res.json({ success: true, data: cached.data });
        return;
      }

      const scopedDepartmentFilterIds = scope === 'department'
        ? await resolveManagedDepartmentIds(req)
        : await resolveDepartmentFilterIds(await resolveScopedDepartmentId(req, null));
      let rowsQuery = supabase
        .from('employees')
        .select('id, org_department_id, employment_status')
        .eq('is_archived', showArchived);

      if (scope === 'self') {
        if (!req.user.employee_id) {
          res.setHeader('Cache-Control', 'private, max-age=30');
          res.json({ success: true, data: { byDepartment: {}, byStatus: { active: 0, fired: 0 } } });
          return;
        }
        rowsQuery = rowsQuery.eq('id', req.user.employee_id);
      } else if (scopedDepartmentFilterIds?.length) {
        rowsQuery = scopedDepartmentFilterIds.length === 1
          ? rowsQuery.eq('org_department_id', scopedDepartmentFilterIds[0])
          : rowsQuery.in('org_department_id', scopedDepartmentFilterIds);
      }

      const { data: rows } = await rowsQuery;

      const byDepartment: Record<string, number> = {};
      const byStatus = { active: 0, fired: 0 };
      for (const row of rows || []) {
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

      const payload = { byDepartment, byStatus };
      countsCache.set(cacheKey, { data: payload, expiresAt: Date.now() + COUNTS_TTL_MS });
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.json({ success: true, data: payload });
    } catch (error) {
      console.error('Get employee counts error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch counts' });
    }
  },

  /**
   * GET /api/employees/:id
   * Использует in-memory кэш (TTL 60с) + ETag для HTTP 304.
   */
  async getById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const idNum = Number(req.params.id);
      if (!idNum || Number.isNaN(idNum)) {
        res.status(400).json({ success: false, error: 'Invalid employee id' });
        return;
      }
      if (!(await canAccessEmployeeInScope(req, idNum))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      const ifNoneMatch = req.header('if-none-match');
      const cached = employeeCache.get(idNum);

      if (cached) {
        res.setHeader('ETag', cached.etag);
        res.setHeader('Cache-Control', 'private, max-age=30, must-revalidate');
        if (ifNoneMatch && ifNoneMatch === cached.etag) {
          res.status(304).end();
          return;
        }
        res.json({ success: true, data: cached.data });
        return;
      }

      const employeeResult = await supabase
        .from('employees')
        .select(EMPLOYEE_FULL_COLUMNS)
        .eq('id', idNum)
        .single();

      if (employeeResult.error || !employeeResult.data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      const structureCache = await loadStructureCache();
      const employee = decryptEmployee(employeeResult.data as unknown as EmployeeEncrypted, structureCache);

      // Подмешиваем активное назначение (участок + руководитель участка)
      const today = new Date().toISOString().slice(0, 10);
      const assignmentResult = await supabase
        .from('employee_assignments')
        .select('org_site_id, is_primary, effective_from, effective_to')
        .eq('employee_id', idNum)
        .lte('effective_from', today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order('is_primary', { ascending: false, nullsFirst: false })
        .order('effective_from', { ascending: false })
        .limit(1);

      const activeAssignment = assignmentResult.data?.[0] ?? null;
      if (activeAssignment?.org_site_id) {
        const siteResult = await supabase
          .from('org_sites')
          .select('name, manager_id')
          .eq('id', activeAssignment.org_site_id)
          .maybeSingle();

        if (siteResult.data) {
          employee.site_name = siteResult.data.name ?? null;
          if (siteResult.data.manager_id) {
            const managerResult = await supabase
              .from('employees')
              .select('full_name')
              .eq('id', siteResult.data.manager_id)
              .maybeSingle();
            if (managerResult.data) {
              employee.site_manager_full_name = managerResult.data.full_name ?? null;
            }
          }
        }
      }

      const entry = employeeCache.set(idNum, employee);

      res.setHeader('ETag', entry.etag);
      res.setHeader('Cache-Control', 'private, max-age=30, must-revalidate');
      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Get employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch employee' });
    }
  },

  /**
   * POST /api/employees — приём на работу через Sigur.
   * Создаёт сотрудника сначала в Sigur (ФИО, отдел, должность, табельный),
   * получает sigur_employee_id, затем вставляет в нашу БД и пишет историю
   * (employee_assignments + employee_history) с effective_from = hire_date.
   */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    let sigurEmployeeIdCreated: number | null = null;
    try {
      const validated = createEmployeeSchema.parse(req.body);
      const scope = await resolveRequestDataScope(req);
      if (!scope || scope === 'self') {
        res.status(403).json({ success: false, error: 'Недостаточно прав для создания сотрудника' });
        return;
      }
      if (scope === 'department') {
        const scopedDepartmentId = await resolveScopedDepartmentId(req, validated.org_department_id);
        if (!scopedDepartmentId) {
          res.status(403).json({ success: false, error: 'Можно создавать сотрудников только в назначенных бригадах' });
          return;
        }
        validated.org_department_id = scopedDepartmentId;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;

      if (!(await sigurService.isConfigured())) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      if (await isProtectedArchiveDepartment(validated.org_department_id, connection)) {
        res.status(409).json({ success: false, error: 'Нельзя создавать сотрудника в папке «Уволенные»' });
        return;
      }

      const { data: departmentRow, error: departmentErr } = await supabase
        .from('org_departments')
        .select('id, sigur_department_id, name')
        .eq('id', validated.org_department_id)
        .eq('is_active', true)
        .maybeSingle();
      if (departmentErr || !departmentRow) {
        res.status(400).json({ success: false, error: 'Отдел не найден или неактивен' });
        return;
      }
      if (!departmentRow.sigur_department_id) {
        res.status(409).json({ success: false, error: `У отдела «${departmentRow.name}» нет привязки к Sigur` });
        return;
      }

      const { data: positionRow, error: positionErr } = await supabase
        .from('positions')
        .select('id, sigur_position_id, name')
        .eq('id', validated.position_id)
        .maybeSingle();
      if (positionErr || !positionRow) {
        res.status(400).json({ success: false, error: 'Должность не найдена' });
        return;
      }
      if (!positionRow.sigur_position_id) {
        res.status(409).json({ success: false, error: `У должности «${positionRow.name}» нет привязки к Sigur` });
        return;
      }

      const fio = parseFIO(validated.full_name);
      const tabNumber = validated.tab_number?.trim() || null;

      // 1. Создаём в Sigur
      const sigurProfile = await createSigurEmployee({
        name: validated.full_name,
        departmentId: departmentRow.sigur_department_id,
        positionId: positionRow.sigur_position_id,
        tabId: tabNumber,
        description: null,
        blocked: false,
      }, connection);
      sigurEmployeeIdCreated = sigurProfile.sigurEmployeeId;

      // 2. Пишем в нашу БД
      const { data, error } = await supabase
        .from('employees')
        .insert({
          full_name: validated.full_name,
          last_name: fio.lastName,
          first_name: fio.firstName || null,
          middle_name: fio.middleName || null,
          hire_date: validated.hire_date,
          org_department_id: validated.org_department_id,
          position_id: validated.position_id,
          sigur_employee_id: sigurEmployeeIdCreated,
          tab_number: tabNumber,
          employment_status: 'active',
          department_locked: false,
        })
        .select(EMPLOYEE_FULL_COLUMNS)
        .single();

      if (error || !data) {
        // Откатить создание в Sigur не можем автоматически (могли успеть события), поэтому:
        // — блокируем созданного сотрудника в Sigur, чтобы он точно не ходил по пропуску;
        // — логируем, чтобы администратор мог подчистить.
        const orphanSigurId = sigurEmployeeIdCreated;
        console.error('[createEmployee] Sigur create succeeded but DB insert failed, manual cleanup needed', {
          sigurEmployeeId: orphanSigurId,
          error,
        });
        try {
          await sigurService.blockEmployee(orphanSigurId, connection);
        } catch (blockErr) {
          console.error('[createEmployee] failed to block orphan Sigur employee', {
            sigurEmployeeId: orphanSigurId,
            blockErr,
          });
        }
        res.status(500).json({
          success: false,
          error: `Sigur-сотрудник создан (id=${orphanSigurId}), но запись в БД не создана. Заблокируйте его вручную в Sigur.`,
          detail: error?.message || 'insert failed',
        });
        return;
      }

      const newEmployeeId = Number(data.id);
      employeeCache.invalidate(newEmployeeId);

      // 3. История: назначение отдела и должности с hire_date
      try {
        await employeeChangesService.changeDepartment(newEmployeeId, validated.org_department_id, {
          reason: 'Приём на работу',
          lockDepartment: false,
          createdBy: req.user.id,
          effectiveDate: validated.hire_date,
        });
      } catch (assignErr) {
        console.warn('[createEmployee] changeDepartment failed (non-critical):', assignErr);
      }
      try {
        await employeeChangesService.changePosition(newEmployeeId, validated.position_id, {
          reason: 'Приём на работу',
          effectiveDate: validated.hire_date,
        });
      } catch (positionErr) {
        console.warn('[createEmployee] changePosition failed (non-critical):', positionErr);
      }

      await auditService.logFromRequest(req, req.user.id, 'CREATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: String(newEmployeeId),
        details: {
          sigur_employee_id: sigurEmployeeIdCreated,
          org_department_id: validated.org_department_id,
          position_id: validated.position_id,
          hire_date: validated.hire_date,
          tab_number: tabNumber,
        },
      });

      const structureCache = await loadStructureCache();
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
      res.status(201).json({ success: true, data: employee });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('[createEmployee] error', { sigurEmployeeIdCreated, error });
      const message = error instanceof Error && error.message ? error.message : 'Failed to create employee';
      res.status(500).json({
        success: false,
        error: sigurEmployeeIdCreated
          ? `Ошибка после создания в Sigur (id=${sigurEmployeeIdCreated}): ${message}. Проверьте запись вручную.`
          : `Не удалось создать сотрудника: ${message}`,
      });
    }
  },

  /**
   * PUT /api/employees/:id
   */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const validated = updateEmployeeSchema.parse(req.body);
      const employeeId = Number(id);
      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }
      const scope = await resolveRequestDataScope(req);
      if (scope === 'department' && validated.org_department_id) {
        const scopedDepartmentId = await resolveScopedDepartmentId(req, validated.org_department_id);
        if (!scopedDepartmentId) {
          res.status(403).json({ success: false, error: 'Нельзя перевести сотрудника в неназначенную бригаду при department scope' });
          return;
        }
      }

      const { data: existing } = await supabase
        .from('employees')
        .select('id, sigur_employee_id')
        .eq('id', id)
        .single();

      if (!existing) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      if (existing.sigur_employee_id) {
        const linkedSigurManagedKeys = new Set(['full_name', 'tab_number']);
        const linkedLocalAllowedKeys = new Set([
          'birth_date',
          'hire_date',
          'staff_units',
          'country',
          'pension_number',
          'patent_issue_date',
          'patent_expiry_date',
          'email',
          'current_status',
          'permit_expiry_date',
          'registration_cat1',
          'registration_cat4',
          'doc_receipt_date',
          'work_object',
        ]);
        const allowedKeys = new Set([...linkedSigurManagedKeys, ...linkedLocalAllowedKeys]);
        const providedKeys = Object.keys(validated).filter((key) => validated[key as keyof typeof validated] !== undefined);
        const forbiddenKeys = providedKeys.filter(key => !allowedKeys.has(key));

        if (forbiddenKeys.length > 0) {
          res.status(400).json({
            success: false,
            error: 'Для сотрудников, связанных с Sigur, через эту форму нельзя менять отдел, должность и оклады',
          });
          return;
        }

        const sigurPayload: Record<string, unknown> = {};
        if (validated.full_name !== undefined) {
          sigurPayload.name = validated.full_name.trim();
        }
        if (validated.tab_number !== undefined) {
          sigurPayload.tabId = validated.tab_number?.trim() || null;
        }

        if (Object.keys(sigurPayload).length > 0) {
          await sigurService.updateEmployee(existing.sigur_employee_id, sigurPayload);
        }

        const localUpdateData: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };

        if (validated.birth_date !== undefined) {
          localUpdateData.birth_date = validated.birth_date || null;
        }
        if (validated.hire_date !== undefined) {
          localUpdateData.hire_date = validated.hire_date;
        }
        if (validated.staff_units !== undefined) {
          localUpdateData.staff_units = validated.staff_units ?? null;
        }
        if (validated.country !== undefined) {
          localUpdateData.country = validated.country || null;
        }
        if (validated.pension_number !== undefined) {
          localUpdateData.pension_number = validated.pension_number || null;
        }
        if (validated.patent_issue_date !== undefined) {
          localUpdateData.patent_issue_date = validated.patent_issue_date || null;
        }
        if (validated.patent_expiry_date !== undefined) {
          localUpdateData.patent_expiry_date = validated.patent_expiry_date || null;
        }
        if (validated.email !== undefined) {
          localUpdateData.email = validated.email || null;
        }
        if (validated.current_status !== undefined) {
          localUpdateData.current_status = validated.current_status || null;
        }
        if (validated.permit_expiry_date !== undefined) {
          localUpdateData.permit_expiry_date = validated.permit_expiry_date || null;
        }
        if (validated.registration_cat1 !== undefined) {
          localUpdateData.registration_cat1 = validated.registration_cat1 || null;
        }
        if (validated.registration_cat4 !== undefined) {
          localUpdateData.registration_cat4 = validated.registration_cat4 || null;
        }
        if (validated.doc_receipt_date !== undefined) {
          localUpdateData.doc_receipt_date = validated.doc_receipt_date || null;
        }
        if (validated.work_object !== undefined) {
          localUpdateData.work_object = validated.work_object || null;
        }

        if (Object.keys(localUpdateData).length > 1) {
          const { error: localUpdateError } = await supabase
            .from('employees')
            .update(localUpdateData)
            .eq('id', id);

          if (localUpdateError) {
            res.status(500).json({ success: false, error: 'Failed to update employee' });
            return;
          }
        }

        await syncLinkedEmployeeFromSigur(employeeId);

        employeeCache.invalidate(id);
        const { data: refreshed, error: refreshedError } = await supabase
          .from('employees')
          .select(EMPLOYEE_FULL_COLUMNS)
          .eq('id', id)
          .single();

        if (refreshedError || !refreshed) {
          res.status(500).json({ success: false, error: 'Failed to refresh employee after Sigur update' });
          return;
        }

        await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
          entityType: 'employee',
          entityId: id,
          details: { updated_fields: providedKeys, source: 'sigur' },
        });

        const structureCache = await loadStructureCache();
        const employee = decryptEmployee(refreshed as unknown as EmployeeEncrypted, structureCache);
        res.json({ success: true, data: employee });
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
      if (validated.current_salary !== undefined || validated.salary_actual !== undefined) {
        const canonicalSalary = validated.current_salary ?? validated.salary_actual ?? null;
        updateData.current_salary = canonicalSalary;
        updateData.salary_actual = canonicalSalary;
      }
      if (validated.salary_calculated !== undefined) {
        updateData.salary_calculated = validated.salary_calculated ?? null;
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
        updateData.email = validated.email || null;
      }
      if (validated.tab_number !== undefined) {
        updateData.tab_number = validated.tab_number || null;
      }
      if (validated.current_status !== undefined) {
        updateData.current_status = validated.current_status || null;
      }
      if (validated.permit_expiry_date !== undefined) {
        updateData.permit_expiry_date = validated.permit_expiry_date || null;
      }
      if (validated.registration_cat1 !== undefined) {
        updateData.registration_cat1 = validated.registration_cat1 || null;
      }
      if (validated.registration_cat4 !== undefined) {
        updateData.registration_cat4 = validated.registration_cat4 || null;
      }
      if (validated.doc_receipt_date !== undefined) {
        updateData.doc_receipt_date = validated.doc_receipt_date || null;
      }
      if (validated.work_object !== undefined) {
        updateData.work_object = validated.work_object || null;
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
        .select(EMPLOYEE_FULL_COLUMNS)
        .single();

      if (error) {
        console.error('Update employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to update employee' });
        return;
      }

      employeeCache.invalidate(id);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
        details: { updated_fields: Object.keys(validated) },
      });

      const structureCache = await loadStructureCache();
      const employee = decryptEmployee(data as unknown as EmployeeEncrypted, structureCache);
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
      if (!(await canAccessEmployeeInScope(req, Number(id)))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }

      const { error } = await supabase
        .from('employees')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('Delete employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete employee' });
        return;
      }

      employeeCache.invalidate(id);

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
      if (!(await canAccessEmployeeInScope(req, Number(id)))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }
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

      employeeCache.invalidate(id);

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
      const employeeId = Number(id);
      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
        return;
      }
      const { position_name, reason, effective_date } = req.body as { position_name: string; reason?: string; effective_date?: string };

      if (!position_name?.trim()) {
        res.status(400).json({ success: false, error: 'position_name is required' });
        return;
      }

      const name = position_name.trim();
      const { data: employeeRow, error: employeeError } = await supabase
        .from('employees')
        .select('id, sigur_employee_id, position_id')
        .eq('id', employeeId)
        .single();

      if (employeeError || !employeeRow) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      let positionId: string | null = null;

      if (employeeRow.sigur_employee_id) {
        const ensured = await ensureSigurPosition(name);
        positionId = ensured.localPositionId;

        await sigurService.updateEmployee(employeeRow.sigur_employee_id, {
          positionId: ensured.sigurPositionId,
        });

        if (positionId && positionId !== employeeRow.position_id) {
          await employeeChangesService.changePosition(employeeId, positionId, {
            reason,
            effectiveDate: effective_date,
            createdBy: req.user.id,
          });
        }

        await syncLinkedEmployeeFromSigur(employeeId);
      } else {
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

        if (!positionId) {
          throw new Error('Не удалось определить локальную должность');
        }

        await employeeChangesService.changePosition(employeeId, positionId, {
          reason,
          effectiveDate: effective_date,
          createdBy: req.user.id,
        });
      }

      employeeCache.invalidate(id);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
        details: { position_name: name, reason, source: employeeRow.sigur_employee_id ? 'sigur' : 'portal' },
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
  batchMoveEmployees,
  getHistory,
  updateHistoryEvent,
  deleteHistoryEvent,

  // Методы из employee-import.controller.ts
  deleteAll,
};
