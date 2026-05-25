import { Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { localAuthService } from '../services/local-auth.service.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, ChatInboundMode, UserProfile } from '../types/index.js';
import { logSupabaseError } from './admin-helpers.js';
import { getAllRoles, getRoleByCode } from '../services/roles-cache.service.js';
import { ensureCriticalAdminAccess } from '../services/critical-admin-access.service.js';
import {
  loadEmployeeManagerAssignmentMap,
  loadExplicitManagerAssignmentMap,
  loadAssignedEmployeeMap,
  replaceUserEmployeeAccess,
} from '../services/department-access.service.js';
import {
  listObjectIdsForEmployee,
  replaceEmployeeObjectAccess,
} from '../services/employee-skud-object-access.service.js';
import { invalidatePresenceByObjectCache } from '../services/skud-presence-by-object.service.js';
import { invalidateDashboardCache } from '../services/skud-dashboard.service.js';
import {
  canAccessEmployeeInScope,
  resolveAccessibleDepartmentIds,
  resolveCompanyScope,
} from '../services/data-scope.service.js';
import { invalidateDepartmentScopeCaches } from '../services/scope-cache.service.js';
import { notificationService } from '../services/notification.service.js';
import { pushService } from '../services/push.service.js';
import { escapeLike } from '../utils/search.utils.js';
import {
  buildManagerDepartmentImportPreviewFromBuffer,
  saveManagerDepartmentImportAliases,
} from '../services/manager-department-import.service.js';
import { employeeChangesService } from '../services/employee-changes.service.js';
import { employeeCache } from '../services/employee-cache.service.js';
import { getIo } from '../socket/io-instance.js';

function emitDepartmentAccessChanged(targetUserId: string | null | undefined): void {
  if (!targetUserId) return;
  const io = getIo();
  if (!io) return;
  io.to(`user:${targetUserId}`).emit('profile:access_changed');
}
import {
  loadEmployeeFullNamesMap,
  loadDepartmentNamesMap,
  loadUserFullName,
} from '../services/audit-context.helpers.js';

const approveUserSchema = z.object({
  position_type: z.string().min(1),
  employee_id: z.number().int().positive().optional(),
});

const updateDepartmentAccessSchema = z.object({
  department_ids: z.array(z.string().uuid()).default([]),
});

const updateEmployeeAccessSchema = z.object({
  employee_ids: z.array(z.number().int().positive()).default([]),
});

const updateEmployeeSkudObjectsSchema = z.object({
  object_ids: z.array(z.string().uuid()).default([]),
});

const setSiteSupervisorSchema = z.object({
  is_site_supervisor: z.boolean(),
});

const applyBrigadeWorkerTransfersSchema = z.object({
  transfers: z.array(z.object({
    employee_id: z.number().int().positive(),
    target_department_id: z.string().uuid(),
    effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })).min(1),
});

const applyDepartmentAccessImportSchema = z.object({
  assignments: z.array(z.object({
    employee_id: z.number().int().positive(),
    department_ids: z.array(z.string().uuid()).default([]),
    source_groups: z.array(z.string()).default([]),
  })).default([]),
  group_assignments: z.array(z.object({
    section_name: z.string().nullable().optional(),
    manager_name: z.string().min(1),
    employee_id: z.number().int().positive(),
  })).default([]),
  brigade_aliases: z.array(z.object({
    section_name: z.string().nullable().optional(),
    brigade_name: z.string().min(1),
    department_id: z.string().uuid(),
  })).default([]),
});

function uniqueStringValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(
    values
      .map(value => String(value || '').trim())
      .filter(Boolean),
  )];
}

async function resolveActiveRoleAssignment(positionType: string): Promise<{ id: string; code: string } | null> {
  const role = await getRoleByCode(positionType);
  if (!role || !role.is_active) {
    return null;
  }

  return {
    id: role.id,
    code: role.code,
  };
}

/**
 * Проверяет что все department_id из payload в зоне доступа админа компании.
 * Системный админ (scope='all') пропускается без проверки.
 */
async function ensureDepartmentIdsInScope(
  req: AuthenticatedRequest,
  departmentIds: string[],
): Promise<{ ok: true } | { ok: false; outOfScope: string[] }> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return { ok: true };
  const accessibleSet = new Set(accessible);
  const outOfScope = departmentIds.filter(id => !accessibleSet.has(id));
  if (outOfScope.length > 0) return { ok: false, outOfScope };
  return { ok: true };
}

/**
 * Проверяет, что целевой пользователь портала находится в company-scope админа
 * (по связанному employee.org_department_id). Системный админ (scope='all')
 * пропускается.
 * Возвращает 403 для company-admin, если: user не найден, не имеет employee_id
 * или employee находится вне scope.
 */
async function assertTargetUserInScope(
  req: AuthenticatedRequest,
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return { ok: true };

  const profile = await queryOne<{ employee_id: number | null }>(
    'SELECT employee_id FROM user_profiles WHERE id = $1::uuid',
    [targetUserId],
  );
  if (!profile) return { ok: false, status: 404, error: 'Пользователь не найден' };
  if (!profile.employee_id) {
    return { ok: false, status: 403, error: 'Пользователь без сотрудника недоступен в вашем скоупе' };
  }

  const allowed = await canAccessEmployeeInScope(req, profile.employee_id);
  if (!allowed) return { ok: false, status: 403, error: 'Пользователь вне вашей зоны доступа' };
  return { ok: true };
}

/**
 * Фильтрует список user_profiles по company-scope: оставляет только тех, чей
 * employee.org_department_id попадает в scope. Системный админ (scope='all')
 * получает исходный список как есть.
 */
async function filterUsersByCompanyScope<T extends { employee_id: number | null }>(
  req: AuthenticatedRequest,
  users: T[],
): Promise<T[]> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return users;
  const accessibleSet = new Set(accessible);

  const employeeIds = [...new Set(users.map(u => u.employee_id).filter((id): id is number => typeof id === 'number'))];
  if (employeeIds.length === 0) return [];

  const data = await query<{ id: number; org_department_id: string | null }>(
    'SELECT id, org_department_id FROM employees WHERE id = ANY($1::int[])',
    [employeeIds],
  );
  const employeeDeptMap = new Map<number, string | null>();
  for (const row of data) {
    employeeDeptMap.set(row.id, row.org_department_id);
  }

  return users.filter(user => {
    if (user.employee_id == null) return false;
    const deptId = employeeDeptMap.get(user.employee_id);
    return deptId != null && accessibleSet.has(deptId);
  });
}

async function validateDepartmentIds(departmentIds: string[]): Promise<{ missingIds: string[] }> {
  const normalizedDepartmentIds = uniqueStringValues(departmentIds);
  if (normalizedDepartmentIds.length === 0) {
    return { missingIds: [] };
  }

  const departments = await query<{ id: string }>(
    'SELECT id FROM org_departments WHERE id = ANY($1::uuid[])',
    [normalizedDepartmentIds],
  );

  const foundIds = new Set(departments.map(department => department.id));
  return {
    missingIds: normalizedDepartmentIds.filter(departmentId => !foundIds.has(departmentId)),
  };
}

// sigur_sync-строки — это членство (миграция 049 + employee-lifecycle),
// их никогда не трогаем: data-scope и chat-policy опираются на них,
// а HR-назначения должны заменяться независимо.
const MEMBERSHIP_SOURCE = 'sigur_sync';

async function replaceExplicitDepartmentAccess(params: {
  employeeId: number;
  departmentIds: string[];
  actorUserId: string;
  source: string;
}): Promise<string[]> {
  const explicitDepartmentIds = uniqueStringValues(params.departmentIds);

  const existingAccessRows = await query<{ department_id: string; is_active: boolean; source: string }>(
    `SELECT department_id, is_active, source
       FROM employee_department_access
      WHERE employee_id = $1 AND source <> $2`,
    [params.employeeId, MEMBERSHIP_SOURCE],
  );

  const nextDepartmentSet = new Set(explicitDepartmentIds);
  const activeDepartmentIds = existingAccessRows
    .filter(row => row.is_active)
    .map(row => row.department_id)
    .filter(Boolean);
  const departmentIdsToDeactivate = activeDepartmentIds
    .filter(departmentId => !nextDepartmentSet.has(departmentId));

  const now = new Date().toISOString();

  if (explicitDepartmentIds.length > 0) {
    // Bulk UPSERT через unnest — каждый ряд из массива параметров.
    await execute(
      `INSERT INTO employee_department_access
         (employee_id, department_id, source, is_active, created_by, updated_at)
       SELECT $1::int, dept_id, $2::text, true, $3::uuid, $4::timestamptz
         FROM unnest($5::uuid[]) AS dept_id
       ON CONFLICT (employee_id, department_id)
       DO UPDATE SET
         source = EXCLUDED.source,
         is_active = true,
         created_by = EXCLUDED.created_by,
         updated_at = EXCLUDED.updated_at`,
      [params.employeeId, params.source, params.actorUserId, now, explicitDepartmentIds],
    );
  }

  if (departmentIdsToDeactivate.length > 0) {
    await execute(
      `UPDATE employee_department_access
          SET is_active = false, updated_at = $1::timestamptz
        WHERE employee_id = $2
          AND department_id = ANY($3::uuid[])
          AND source <> $4`,
      [now, params.employeeId, departmentIdsToDeactivate, MEMBERSHIP_SOURCE],
    );
  }

  return explicitDepartmentIds;
}

async function upsertEmployeeDepartmentAccess(params: {
  employeeId: number;
  departmentIds: string[];
  actorUserId: string;
  source: string;
}): Promise<string[]> {
  const additionalDepartmentIds = [...new Set(params.departmentIds.map(value => value.trim()))]
    .filter(departmentId => Boolean(departmentId));

  if (additionalDepartmentIds.length === 0) {
    return [];
  }

  const now = new Date().toISOString();
  await execute(
    `INSERT INTO employee_department_access
       (employee_id, department_id, source, is_active, created_by, updated_at)
     SELECT $1::int, dept_id, $2::text, true, $3::uuid, $4::timestamptz
       FROM unnest($5::uuid[]) AS dept_id
     ON CONFLICT (employee_id, department_id)
     DO UPDATE SET
       source = EXCLUDED.source,
       is_active = true,
       created_by = EXCLUDED.created_by,
       updated_at = EXCLUDED.updated_at`,
    [params.employeeId, params.source, params.actorUserId, now, additionalDepartmentIds],
  );

  return additionalDepartmentIds;
}

/**
 * Лёгкий счётчик пользователей для бейджа в табе. Без выборки строк,
 * только COUNT(*) с уважением company-scope.
 */
async function respondUsersCount(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const accessible = await resolveAccessibleDepartmentIds(req);
    let row: { count: number } | null;
    // Ожидающие заявки считаются отдельно в /admin/users/pending — здесь
    // только одобренные, чтобы бейдж «Все пользователи (N)» не включал pending.
    if (accessible === 'all') {
      row = await queryOne<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM user_profiles WHERE is_approved = true',
      );
    } else if (accessible.length === 0) {
      row = { count: 0 };
    } else {
      row = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM user_profiles up
          WHERE up.is_approved = true
            AND up.employee_id IN (
              SELECT id FROM employees WHERE org_department_id = ANY($1::uuid[])
            )`,
        [accessible],
      );
    }
    res.json({ success: true, count: row?.count ?? 0 });
  } catch (err) {
    logSupabaseError('GetUsersCount', err);
    res.status(500).json({ success: false, error: 'Failed to fetch users count' });
  }
}

/**
 * Лёгкий список всех пользователей для cross-tab map'ов
 * (EmployeeDepartmentAssignmentsTab / DepartmentAccessImportTab им нужны
 * только id/full_name/email/employee_id). Без дорогих join'ов.
 */
async function respondSlimUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
  let rawUsers: Array<Pick<UserProfile, 'id' | 'full_name' | 'employee_id'>>;
  try {
    // Ожидающие заявки исключены — slim используется в UI назначений/импорта,
    // где неодобренные пользователи только засоряют выпадающие списки.
    rawUsers = await query<Pick<UserProfile, 'id' | 'full_name' | 'employee_id'>>(
      'SELECT id, full_name, employee_id FROM user_profiles WHERE is_approved = true ORDER BY created_at DESC',
    );
  } catch (usersError) {
    logSupabaseError('GetUsersSlim', usersError);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
    return;
  }

  const users = await filterUsersByCompanyScope(req, rawUsers);
  const userIds = users.map(u => u.id);
  const authUsersById = await localAuthService.getUsersByIds(userIds).catch((err: unknown) => {
    console.error('[GetUsersSlim] Auth fetch error:', err);
    return new Map() as Awaited<ReturnType<typeof localAuthService.getUsersByIds>>;
  });

  const data = users.map(u => ({
    id: u.id,
    full_name: u.full_name,
    email: authUsersById.get(u.id)?.email || '',
    employee_id: u.employee_id,
  }));

  res.json({ success: true, data });
}

/**
 * Пагинированный список с server-side поиском и фильтром по роли.
 * Enrichment (departments / assigned employees / email / 2FA) считается
 * только для слайса страницы. roleCounts — по тем же scope+search фильтрам,
 * но БЕЗ фильтра по роли, чтобы табы ролей показывали корректные тоталы.
 */
async function respondPaginatedUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize as string) || 50));
  const search = ((req.query.search as string) || '').trim();
  const roleCode = ((req.query.role as string) || '').trim();
  const offset = (page - 1) * pageSize;

  const accessible = await resolveAccessibleDepartmentIds(req);

  const allRoles = await getAllRoles();
  const roleCodeById = new Map(allRoles.map(r => [r.id, r.code]));
  const roleIdByCode = new Map(allRoles.map(r => [r.code, r.id]));
  const roleId = roleCode ? roleIdByCode.get(roleCode) : undefined;

  // Базовый фильтр (scope + search) — общий для roleCounts и списка.
  // Ожидающие заявки в этот эндпоинт не попадают: они в /admin/users/pending,
  // иначе они «падали» во вкладку 'office_worker' и искажали roleCounts.
  const baseParams: unknown[] = [];
  const baseWhere: string[] = ['up.is_approved = true'];

  if (accessible !== 'all') {
    if (accessible.length === 0) {
      res.json({
        success: true,
        data: [],
        meta: { page, pageSize, total: 0, totalPages: 0, roleCounts: {} },
      });
      return;
    }
    baseParams.push(accessible);
    baseWhere.push(
      `up.employee_id IN (SELECT id FROM employees WHERE org_department_id = ANY($${baseParams.length}::uuid[]))`,
    );
  }
  if (search) {
    baseParams.push(`%${escapeLike(search)}%`);
    const idx = baseParams.length;
    // Некоррелированный IN — planner превращает в semi-join, для full_name
    // и email отдельно используются GIN/trgm-индексы (миграция 110), потом
    // объединение через PK. Коррелированный EXISTS такой план не давал.
    baseWhere.push(
      `(up.full_name ILIKE $${idx} OR up.id IN (SELECT id FROM app_auth.users WHERE email ILIKE $${idx}))`,
    );
  }

  const baseWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : '';

  let roleCountRows: Array<{ system_role_id: string | null; cnt: number }>;
  try {
    roleCountRows = await query<{ system_role_id: string | null; cnt: number }>(
      `SELECT system_role_id, COUNT(*)::int AS cnt
         FROM user_profiles up
         ${baseWhereSql}
        GROUP BY system_role_id`,
      baseParams,
    );
  } catch (err) {
    console.error('Get users roleCounts error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
    return;
  }
  const roleCounts: Record<string, number> = {};
  for (const row of roleCountRows) {
    const code = roleCodeById.get(row.system_role_id ?? '') ?? '';
    if (!code) continue;
    roleCounts[code] = (roleCounts[code] ?? 0) + Number(row.cnt);
  }

  // Список: базовый фильтр + опциональный фильтр по роли + пагинация.
  const listParams = [...baseParams];
  const listWhere = [...baseWhere];
  if (roleCode) {
    if (!roleId) {
      res.json({
        success: true,
        data: [],
        meta: { page, pageSize, total: 0, totalPages: 0, roleCounts },
      });
      return;
    }
    listParams.push(roleId);
    listWhere.push(`up.system_role_id = $${listParams.length}`);
  }
  const listWhereSql = listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : '';
  listParams.push(pageSize);
  const limitIdx = listParams.length;
  listParams.push(offset);
  const offsetIdx = listParams.length;

  let rows: Array<UserProfile & { total_count: number }>;
  try {
    rows = await query<UserProfile & { total_count: number }>(
      `SELECT up.*, count(*) OVER ()::int AS total_count
         FROM user_profiles up
         ${listWhereSql}
        ORDER BY up.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      listParams,
    );
  } catch (err) {
    console.error('Get users paginated error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
    return;
  }

  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  const totalPages = Math.ceil(total / pageSize);

  const usersSlice = rows as UserProfile[];
  const userIds = usersSlice.map(u => u.id);
  const userEmployeePairs = usersSlice.map(u => ({ user_id: u.id, employee_id: u.employee_id }));

  // assigned_employee_ids/assigned_employees НЕ читаются AllUsersTab UI —
  // не грузим их здесь, экономим 2 запроса (user_employee_access + employees).
  const [assignedDepartmentMap, authUsersById] = await Promise.all([
    loadExplicitManagerAssignmentMap(userEmployeePairs),
    localAuthService.getUsersByIds(userIds).catch((err: unknown) => {
      console.error('[GetUsers] Auth fetch error:', err);
      return new Map() as Awaited<ReturnType<typeof localAuthService.getUsersByIds>>;
    }),
  ]);

  const authEmailMap: Record<string, { email: string; email_confirmed: boolean }> = {};
  for (const [userId, authUser] of authUsersById.entries()) {
    authEmailMap[userId] = {
      email: authUser.email || '',
      email_confirmed: !!authUser.email_confirmed_at,
    };
  }

  const data = usersSlice.map((u: UserProfile) => {
    const assignedDepartmentIds = (assignedDepartmentMap.get(u.id) || []);
    const authInfo = authEmailMap[u.id];
    return {
      id: u.id,
      email: authInfo?.email || '',
      email_confirmed: authInfo?.email_confirmed ?? false,
      full_name: u.full_name,
      assigned_department_ids: assignedDepartmentIds,
      is_site_supervisor: Boolean(u.is_site_supervisor),
      position_type: roleCodeById.get(u.system_role_id) ?? '',
      imported_position: u.imported_position,
      employee_id: u.employee_id,
      supervisor_id: u.supervisor_id,
      chat_inbound_mode: (u.chat_inbound_mode || 'open') as ChatInboundMode,
      is_approved: u.is_approved,
      two_factor_enabled: u.two_factor_enabled,
      approved_at: u.approved_at,
      created_at: u.created_at,
    };
  });

  res.json({
    success: true,
    data,
    meta: { page, pageSize, total, totalPages, roleCounts },
  });
}

async function hardDeleteUserCascade(id: string): Promise<void> {
  await withTransaction(async (client) => {
    // user_profiles.id → app_auth.users CASCADE + миграция 097 каскадят
    // user_profiles → дочерние. Одно удаление чистит всё.
    const r = await client.query(
      'DELETE FROM app_auth.users WHERE id = $1::uuid',
      [id],
    );
    if (r.rowCount === 0) {
      // legacy-профиль без app_auth.users — добиваем напрямую (дочерние
      // всё равно каскадят после 097).
      await client.query(
        'DELETE FROM user_profiles WHERE id = $1::uuid',
        [id],
      );
    }
  });
}

export const adminUsersController = {
  async getAllUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (req.query.countOnly === '1') {
        await respondUsersCount(req, res);
        return;
      }
      if (req.query.slim === '1') {
        await respondSlimUsers(req, res);
        return;
      }
      if (req.query.page !== undefined) {
        await respondPaginatedUsers(req, res);
        return;
      }

      let rawUsers: UserProfile[];
      try {
        rawUsers = await query<UserProfile>(
          'SELECT * FROM user_profiles ORDER BY created_at DESC',
        );
      } catch (usersError) {
        logSupabaseError('GetUsers', usersError);
        res.status(500).json({ success: false, error: 'Failed to fetch users' });
        return;
      }

      const users = await filterUsersByCompanyScope(req, rawUsers);

      const userIds = users.map((u: UserProfile) => u.id);
      const userEmployeePairs = users.map((u: UserProfile) => ({
        user_id: u.id,
        employee_id: u.employee_id,
      }));

      // Эти 4 запроса независимы (читают по userIds/userEmployeePairs) — гоним
      // параллельно, чтобы убрать водопад sequential await'ов. Раньше суммарный
      // wall-time = sum(t_i), теперь = max(t_i). На типичной БД ~250-300 мс экономии.
      const [
        assignedDepartmentMap,
        assignedEmployeeMap,
        allRoles,
        authUsersById,
      ] = await Promise.all([
        loadExplicitManagerAssignmentMap(userEmployeePairs),
        loadAssignedEmployeeMap(userIds),
        getAllRoles(),
        localAuthService.getUsersByIds(userIds).catch((err: unknown) => {
          console.error('[GetUsers] Auth fetch error:', err);
          return new Map() as Awaited<ReturnType<typeof localAuthService.getUsersByIds>>;
        }),
      ]);

      // Подгрузим ФИО назначенных сотрудников одним батчем — фронт показывает
      // их сразу в карточке начальника участка, без отдельного fetch на id→name.
      // Зависит от assignedEmployeeMap, поэтому идёт sequential после Promise.all.
      const allAssignedEmployeeIds = [...new Set(
        Array.from(assignedEmployeeMap.values()).flat(),
      )];
      const assignedEmployeeNames = allAssignedEmployeeIds.length > 0
        ? await loadEmployeeFullNamesMap(allAssignedEmployeeIds)
        : new Map<number, string>();

      const roleCodeById = new Map(allRoles.map(r => [r.id, r.code]));

      const authEmailMap: Record<string, { email: string; email_confirmed: boolean }> = {};
      for (const [userId, authUser] of authUsersById.entries()) {
        authEmailMap[userId] = {
          email: authUser.email || '',
          email_confirmed: !!authUser.email_confirmed_at,
        };
      }

      const sanitizedUsers = users.map((u: UserProfile) => {
        const assignedDepartmentIds = (assignedDepartmentMap.get(u.id) || []);
        const assignedEmployeeIds = (assignedEmployeeMap.get(u.id) || []);
        const assignedEmployees = assignedEmployeeIds.map(eid => ({
          id: eid,
          full_name: assignedEmployeeNames.get(eid) || '',
        }));
        const authInfo = authEmailMap[u.id];
        return {
          id: u.id,
          email: authInfo?.email || '',
          email_confirmed: authInfo?.email_confirmed ?? false,
          full_name: u.full_name,
          assigned_department_ids: assignedDepartmentIds,
          assigned_employee_ids: assignedEmployeeIds,
          assigned_employees: assignedEmployees,
          is_site_supervisor: Boolean(u.is_site_supervisor),
          position_type: roleCodeById.get(u.system_role_id) ?? '',
          imported_position: u.imported_position,
          employee_id: u.employee_id,
          supervisor_id: u.supervisor_id,
          chat_inbound_mode: (u.chat_inbound_mode || 'open') as ChatInboundMode,
          is_approved: u.is_approved,
          two_factor_enabled: u.two_factor_enabled,
          approved_at: u.approved_at,
          created_at: u.created_at,
        };
      });

      res.json({ success: true, data: sanitizedUsers });
    } catch (error) {
      console.error('[GetUsers-Catch] Error:', error instanceof Error ? error.stack : error);
      res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }
  },

  async getEmployeeDepartmentAssignments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const accessible = await resolveAccessibleDepartmentIds(req);
      if (accessible !== 'all' && accessible.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      type EmployeeRow = {
        id: number;
        full_name: string;
        position_id: string | number | null;
        org_department_id: string | null;
      };
      let employees: EmployeeRow[];
      try {
        if (accessible === 'all') {
          employees = await query<EmployeeRow>(
            `SELECT id, full_name, position_id, org_department_id
               FROM employees
              WHERE employment_status = 'active' AND is_archived = false
              ORDER BY full_name ASC
              LIMIT 10000`,
          );
        } else {
          employees = await query<EmployeeRow>(
            `SELECT id, full_name, position_id, org_department_id
               FROM employees
              WHERE employment_status = 'active' AND is_archived = false
                AND org_department_id = ANY($1::uuid[])
              ORDER BY full_name ASC
              LIMIT 10000`,
            [accessible],
          );
        }
      } catch (employeesError) {
        logSupabaseError('GetEmployeeDepartmentAssignments', employeesError);
        res.status(500).json({ success: false, error: 'Не удалось загрузить назначения сотрудников' });
        return;
      }

      const employeeIds = employees.map(employee => employee.id);
      // HR-экран «Назначения сотрудников»: показываем только ручные
      // назначения (manual/excel/manager_excel), sigur_sync (членство) сюда
      // не попадает — иначе каждый сотрудник виднелся бы с 1 «назначением».
      const explicitDepartmentMap = await loadEmployeeManagerAssignmentMap(employeeIds);

      const positionIds = [...new Set(employees
        .map(e => e.position_id)
        .filter((id): id is string | number => id != null))];
      const departmentIds = [...new Set(employees
        .map(e => e.org_department_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0))];

      const positionIdsAsText = positionIds.map(v => String(v));
      const [positionRows, departmentRows] = await Promise.all([
        positionIdsAsText.length > 0
          ? query<{ id: string | number; name: string }>(
              'SELECT id, name FROM positions WHERE id::text = ANY($1::text[])',
              [positionIdsAsText],
            )
          : Promise.resolve([] as Array<{ id: string | number; name: string }>),
        departmentIds.length > 0
          ? query<{ id: string; name: string }>(
              'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
              [departmentIds],
            )
          : Promise.resolve([] as Array<{ id: string; name: string }>),
      ]);
      const positionMap = new Map<string, string>(
        positionRows.map(p => [String(p.id), p.name]),
      );
      const departmentMap = new Map<string, string>(
        departmentRows.map(d => [String(d.id), d.name]),
      );

      const payload = employees.map(employee => ({
        employee_id: employee.id,
        full_name: employee.full_name,
        assigned_department_ids: explicitDepartmentMap.get(employee.id) || [],
        position_name: employee.position_id != null
          ? (positionMap.get(String(employee.position_id)) ?? null)
          : null,
        department_name: employee.org_department_id
          ? (departmentMap.get(String(employee.org_department_id)) ?? null)
          : null,
      }));

      res.json({ success: true, data: payload });
    } catch (error) {
      logSupabaseError('GetEmployeeDepartmentAssignments-Catch', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить назначения сотрудников' });
    }
  },

  async getPendingUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      let users: UserProfile[];
      try {
        // JOIN на app_auth.users — orphan-профили (строка user_profiles без
        // учётной записи) исключаются: по ним вход невозможен, одобрять их
        // бессмысленно, а в очереди они перехватывают одобрение у актуальной
        // заявки → одобренный пользователь видит «Ожидание одобрения».
        users = await query<UserProfile>(
          `SELECT up.* FROM user_profiles up
             JOIN app_auth.users au ON au.id = up.id
            WHERE up.is_approved = false
            ORDER BY up.created_at DESC`,
        );
      } catch (usersError) {
        logSupabaseError('GetPendingUsers', usersError);
        res.status(500).json({ success: false, error: 'Failed to fetch pending users' });
        return;
      }

      // Pending-пользователи могут ещё не иметь employee_id — для company-admin
      // не фильтруем их по employee, иначе вообще ничего не увидит. Pending-список
      // показываем системному админу в полном виде, для company-admin — пустой.
      // Альтернатива (на будущее): pending → company через явное pre-assign.
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.json({ success: true, data: [] });
        return;
      }

      if (users.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      const allRoles = await getAllRoles();
      const roleCodeById = new Map(allRoles.map(r => [r.id, r.code]));

      // Батчевая подгрузка email/email_confirmed из app_auth.users одним запросом
      // вместо N последовательных вызовов getUserById.
      let authUsersById = new Map<string, { email: string; email_confirmed_at: string | null }>();
      try {
        const ids = users.map(u => u.id);
        const fullMap = await localAuthService.getUsersByIds(ids);
        for (const [userId, authUser] of fullMap.entries()) {
          authUsersById.set(userId, {
            email: authUser.email || '',
            email_confirmed_at: authUser.email_confirmed_at,
          });
        }
      } catch (e) {
        console.error('Failed to load pending users emails:', e);
        authUsersById = new Map();
      }

      const usersWithEmail = users.map((u: UserProfile) => {
        const info = authUsersById.get(u.id);
        return {
          id: u.id,
          email: info?.email || '',
          email_confirmed: !!info?.email_confirmed_at,
          full_name: u.full_name,
          position_type: roleCodeById.get(u.system_role_id) ?? '',
          imported_position: u.imported_position,
          created_at: u.created_at,
        };
      });

      res.json({ success: true, data: usersWithEmail });
    } catch (error) {
      console.error('[GetPendingUsers-Catch] Error:', error instanceof Error ? error.stack : error);
      res.status(500).json({ success: false, error: 'Failed to fetch pending users' });
    }
  },

  async previewDepartmentAccessImport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Импорт доступен только системному администратору' });
        return;
      }
      const uploadedFile = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
      if (!uploadedFile) {
        res.status(400).json({ success: false, error: 'Файл не загружен' });
        return;
      }

      const preview = await buildManagerDepartmentImportPreviewFromBuffer(uploadedFile.buffer);
      res.json({ success: true, data: preview });
    } catch (error) {
      // Полный объект — только в логи/Sentry: details.message от Supabase может
      // содержать имена таблиц/колонок, парсер xlsx — путь файла на сервере.
      const details = {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: unknown })?.code ?? null,
        stack: error instanceof Error ? error.stack : undefined,
      };
      console.error('Preview department access import error:', details);
      res.status(500).json({
        success: false,
        error: 'Не удалось обработать Excel-файл. Проверьте формат и повторите.',
      });
    }
  },

  async applyDepartmentAccessImport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Импорт доступен только системному администратору' });
        return;
      }
      const { assignments, group_assignments, brigade_aliases } = applyDepartmentAccessImportSchema.parse(req.body);
      const normalizedAssignments = assignments
        .map(assignment => ({
          employee_id: assignment.employee_id,
          department_ids: [...new Set(assignment.department_ids.map(value => value.trim()))],
          source_groups: [...new Set(assignment.source_groups.map(value => value.trim()).filter(Boolean))],
        }))
        .filter(assignment => assignment.department_ids.length > 0);
      const normalizedGroupAssignments = group_assignments
        .map(groupAssignment => ({
          section_name: groupAssignment.section_name?.trim() || null,
          manager_name: groupAssignment.manager_name.trim(),
          employee_id: groupAssignment.employee_id,
        }))
        .filter(groupAssignment => groupAssignment.manager_name.length > 0);
      const normalizedBrigadeAliases = brigade_aliases
        .map(brigadeAlias => ({
          section_name: brigadeAlias.section_name?.trim() || null,
          brigade_name: brigadeAlias.brigade_name.trim(),
          department_id: brigadeAlias.department_id.trim(),
        }))
        .filter(brigadeAlias => brigadeAlias.brigade_name.length > 0 && brigadeAlias.department_id.length > 0);

      if (normalizedAssignments.length === 0 && normalizedGroupAssignments.length === 0 && normalizedBrigadeAliases.length === 0) {
        res.status(400).json({ success: false, error: 'Нет данных для применения импорта' });
        return;
      }

      const employeeIds = [...new Set([
        ...normalizedAssignments.map(assignment => assignment.employee_id),
        ...normalizedGroupAssignments.map(groupAssignment => groupAssignment.employee_id),
      ])];
      const departmentIds = [...new Set([
        ...normalizedAssignments.flatMap(assignment => assignment.department_ids),
        ...normalizedBrigadeAliases.map(brigadeAlias => brigadeAlias.department_id),
      ])];

      if (employeeIds.length > 0) {
        let employees: Array<{ id: number }>;
        try {
          employees = await query<{ id: number }>(
            'SELECT id FROM employees WHERE id = ANY($1::int[])',
            [employeeIds],
          );
        } catch (employeesError) {
          logSupabaseError('ApplyDepartmentAccessImport-employees', employeesError);
          res.status(500).json({ success: false, error: 'Не удалось проверить выбранных сотрудников' });
          return;
        }

        const foundEmployeeIds = new Set(employees.map(employee => employee.id));
        const missingEmployeeIds = employeeIds.filter(employeeId => !foundEmployeeIds.has(employeeId));
        if (missingEmployeeIds.length > 0) {
          res.status(400).json({
            success: false,
            error: 'Некоторые сотрудники не найдены',
            details: { missing_employee_ids: missingEmployeeIds },
          });
          return;
        }
      }

      if (departmentIds.length > 0) {
        let departments: Array<{ id: string }>;
        try {
          departments = await query<{ id: string }>(
            'SELECT id FROM org_departments WHERE id = ANY($1::uuid[])',
            [departmentIds],
          );
        } catch (departmentsError) {
          logSupabaseError('ApplyDepartmentAccessImport-departments', departmentsError);
          res.status(500).json({ success: false, error: 'Не удалось проверить подразделения из импорта' });
          return;
        }

        const foundDepartmentIds = new Set(departments.map(department => department.id));
        const missingDepartmentIds = departmentIds.filter(departmentId => !foundDepartmentIds.has(departmentId));
        if (missingDepartmentIds.length > 0) {
          res.status(400).json({
            success: false,
            error: 'Некоторые подразделения из импорта не найдены',
            details: { missing_department_ids: missingDepartmentIds },
          });
          return;
        }
      }

      let appliedUsers = 0;
      let appliedLinks = 0;

      const auditEmployeeNames = await loadEmployeeFullNamesMap(
        normalizedAssignments.map(assignment => assignment.employee_id),
      );
      const auditDepartmentNames = await loadDepartmentNamesMap(
        normalizedAssignments.flatMap(assignment => assignment.department_ids),
      );

      for (const assignment of normalizedAssignments) {
        const savedDepartmentIds = await upsertEmployeeDepartmentAccess({
          employeeId: assignment.employee_id,
          departmentIds: assignment.department_ids,
          actorUserId: req.user.id,
          source: 'excel_admin_ui',
        });

        if (savedDepartmentIds.length === 0) {
          continue;
        }

        appliedUsers += 1;
        appliedLinks += savedDepartmentIds.length;

        const assignedDepartmentNames = savedDepartmentIds
          .map(deptId => auditDepartmentNames.get(deptId))
          .filter((name): name is string => Boolean(name));

        await auditService.logFromRequest(req, req.user.id, 'USER_DEPARTMENT_ACCESS_CHANGED', {
          entityType: 'employee',
          entityId: String(assignment.employee_id),
          details: {
            source: 'excel_admin_ui',
            import_groups: assignment.source_groups,
            imported_department_ids: savedDepartmentIds,
            imported_department_count: savedDepartmentIds.length,
            employee_id: assignment.employee_id,
            employee_full_name: auditEmployeeNames.get(assignment.employee_id) ?? null,
            assigned_department_names: assignedDepartmentNames,
          },
        });
      }

      await saveManagerDepartmentImportAliases({
        actor_user_id: req.user.id,
        employee_aliases: normalizedGroupAssignments,
        brigade_aliases: normalizedBrigadeAliases,
      });

      if (appliedUsers > 0 || appliedLinks > 0) {
        invalidateDepartmentScopeCaches();
      }

      res.json({
        success: true,
        data: {
          applied_users: appliedUsers,
          applied_links: appliedLinks,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Apply department access import error:', error);
      res.status(500).json({ success: false, error: 'Не удалось применить импорт назначений' });
    }
  },

  async clearDepartmentAssignments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Очистка назначений доступна только системному администратору' });
        return;
      }
      let deletedCount = 0;
      try {
        deletedCount = await execute(
          `DELETE FROM employee_department_access
            WHERE id <> '00000000-0000-0000-0000-000000000000'::uuid`,
        );
      } catch (error) {
        logSupabaseError('ClearDepartmentAssignments', error);
        res.status(500).json({ success: false, error: 'Не удалось очистить назначения' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_DEPARTMENT_ACCESS_CHANGED', {
        entityType: 'employee',
        entityId: 'all',
        details: { deleted_count: deletedCount },
      });

      if (deletedCount > 0) {
        invalidateDepartmentScopeCaches();
      }

      res.json({ success: true, data: { deleted: deletedCount } });
    } catch (error) {
      console.error('Clear department assignments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось очистить назначения' });
    }
  },

  async applyBrigadeWorkerTransfers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { transfers } = applyBrigadeWorkerTransfersSchema.parse(req.body);

      const dedupedTransfers = [...new Map(
        transfers.map(transfer => [`${transfer.employee_id}::${transfer.target_department_id}`, transfer]),
      ).values()];

      const employeeIds = [...new Set(dedupedTransfers.map(transfer => transfer.employee_id))];
      const departmentIds = [...new Set(dedupedTransfers.map(transfer => transfer.target_department_id))];

      // Company-admin: все целевые отделы и сотрудники должны быть в его scope.
      const accessible = await resolveAccessibleDepartmentIds(req);
      if (accessible !== 'all') {
        const accessibleSet = new Set(accessible);
        const departmentsOutOfScope = departmentIds.filter(id => !accessibleSet.has(id));
        if (departmentsOutOfScope.length > 0) {
          res.status(403).json({
            success: false,
            error: 'Некоторые целевые отделы вне вашей зоны доступа',
            details: { out_of_scope_department_ids: departmentsOutOfScope },
          });
          return;
        }
        for (const employeeId of employeeIds) {
          const ok = await canAccessEmployeeInScope(req, employeeId);
          if (!ok) {
            res.status(403).json({
              success: false,
              error: 'Некоторые сотрудники вне вашей зоны доступа',
              details: { out_of_scope_employee_id: employeeId },
            });
            return;
          }
        }
      }

      type TransferEmployeeRow = {
        id: number;
        full_name: string | null;
        org_department_id: string | null;
        employment_status: string | null;
        is_archived: boolean;
      };
      let employees: TransferEmployeeRow[];
      try {
        employees = await query<TransferEmployeeRow>(
          `SELECT id, full_name, org_department_id, employment_status, is_archived
             FROM employees
            WHERE id = ANY($1::int[])`,
          [employeeIds],
        );
      } catch (employeesError) {
        logSupabaseError('ApplyBrigadeWorkerTransfers-employees', employeesError);
        res.status(500).json({ success: false, error: 'Не удалось проверить сотрудников' });
        return;
      }

      const employeesById = new Map(employees.map(employee => [Number(employee.id), employee]));

      let departments: Array<{ id: string }>;
      try {
        departments = await query<{ id: string }>(
          `SELECT id FROM org_departments
            WHERE id = ANY($1::uuid[]) AND is_active = true`,
          [departmentIds],
        );
      } catch (departmentsError) {
        logSupabaseError('ApplyBrigadeWorkerTransfers-departments', departmentsError);
        res.status(500).json({ success: false, error: 'Не удалось проверить подразделения' });
        return;
      }

      const foundDepartmentIds = new Set(departments.map(department => String(department.id)));

      let applied = 0;
      let restored = 0;
      const skipped: Array<{ employee_id: number; target_department_id: string; reason: string }> = [];
      const errors: Array<{ employee_id: number; target_department_id: string; error: string }> = [];

      for (const transfer of dedupedTransfers) {
        const employee = employeesById.get(transfer.employee_id);
        if (!employee) {
          skipped.push({
            employee_id: transfer.employee_id,
            target_department_id: transfer.target_department_id,
            reason: 'employee_not_found',
          });
          continue;
        }

        if (!foundDepartmentIds.has(transfer.target_department_id)) {
          skipped.push({
            employee_id: transfer.employee_id,
            target_department_id: transfer.target_department_id,
            reason: 'department_not_found',
          });
          continue;
        }

        if (employee.org_department_id === transfer.target_department_id && !employee.is_archived) {
          skipped.push({
            employee_id: transfer.employee_id,
            target_department_id: transfer.target_department_id,
            reason: 'already_in_department',
          });
          continue;
        }

        try {
          await employeeChangesService.changeDepartment(
            transfer.employee_id,
            transfer.target_department_id,
            {
              reason: 'Excel-импорт бригад',
              createdBy: req.user.id,
              effectiveDate: transfer.effective_date,
              lockDepartment: true,
            },
          );

          const restoredFromArchive = Boolean(employee.is_archived);
          if (restoredFromArchive) {
            await execute(
              `UPDATE employees
                  SET is_archived = false,
                      archived_at = NULL,
                      updated_at = $1::timestamptz
                WHERE id = $2`,
              [new Date().toISOString(), transfer.employee_id],
            );
            restored += 1;
          }

          employeeCache.invalidate(transfer.employee_id);

          await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
            entityType: 'employee',
            entityId: String(transfer.employee_id),
            details: {
              source: 'manager_excel_admin_ui',
              from_department_id: employee.org_department_id,
              to_department_id: transfer.target_department_id,
              effective_from: transfer.effective_date || null,
              restored_from_archive: restoredFromArchive,
            },
          });

          applied += 1;
        } catch (transferError) {
          console.error('Apply brigade worker transfer error:', transferError);
          errors.push({
            employee_id: transfer.employee_id,
            target_department_id: transfer.target_department_id,
            error: transferError instanceof Error ? transferError.message : 'unknown_error',
          });
        }
      }

      if (applied > 0 || restored > 0) {
        invalidateDepartmentScopeCaches();
      }

      res.json({
        success: true,
        data: {
          applied,
          restored,
          skipped,
          errors,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Apply brigade worker transfers error:', error);
      res.status(500).json({ success: false, error: 'Не удалось применить переносы сотрудников' });
    }
  },

  async approveUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { position_type, employee_id } = approveUserSchema.parse(req.body);

      // Подтверждать новых пользователей может только системный админ:
      // у pending обычно нет employee_id, scope-фильтр их не видит.
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Подтверждение пользователей доступно только системному администратору' });
        return;
      }

      const roleAssignment = await resolveActiveRoleAssignment(position_type);
      if (!roleAssignment) {
        res.status(400).json({ success: false, error: 'Выбрана несуществующая или неактивная роль' });
        return;
      }

      const profile = await queryOne<UserProfile>(
        'SELECT * FROM user_profiles WHERE id = $1::uuid',
        [id],
      );

      if (!profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      // Профиль без app_auth.users — устаревший orphan-дубль. Логин ходит через
      // app_auth.users, по orphan-профилю войти нельзя; его одобрение ничего не
      // даёт — человек продолжит видеть «Ожидание одобрения». Отклоняем явно.
      const authUser = await localAuthService.getUserById(id);
      if (!authUser) {
        res.status(409).json({
          success: false,
          error: 'У этого профиля нет учётной записи для входа (устаревший дубль). Одобрите актуальную заявку пользователя.',
        });
        return;
      }

      const setClauses: string[] = [
        'is_approved = true',
        'approved_by = $2::uuid',
        'approved_at = $3::timestamptz',
        'system_role_id = $4::uuid',
      ];
      const params: unknown[] = [id, req.user.id, new Date().toISOString(), roleAssignment.id];
      if (employee_id) {
        setClauses.push('employee_id = $5');
        params.push(employee_id);
      }

      let approvedRows: Array<{ id: string }>;
      try {
        approvedRows = await query<{ id: string }>(
          `UPDATE user_profiles SET ${setClauses.join(', ')} WHERE id = $1::uuid RETURNING id`,
          params,
        );
      } catch (updateError) {
        console.error('Approve user error:', updateError);
        res.status(500).json({ success: false, error: 'Failed to approve user' });
        return;
      }
      if (approvedRows.length === 0) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_APPROVED', {
        entityType: 'user',
        entityId: id,
        details: { position_type: roleAssignment.code },
      });

      if (employee_id) {
        try {
          // Уведомляем только если на пользователя есть ручные назначения
          // (manual/excel). Membership (sigur_sync) — это просто «числится
          // в отделе», а не «отвечает за табели».
          const accessMap = await loadEmployeeManagerAssignmentMap([employee_id]);
          const departmentIds = accessMap.get(employee_id) || [];

          if (departmentIds.length > 0) {
            const departments = await query<{ id: string; name: string | null }>(
              'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
              [departmentIds],
            );

            const nameById = new Map<string, string>(
              departments.map(d => [d.id, d.name || 'Без названия']),
            );
            const names = departmentIds
              .map(depId => nameById.get(depId) || 'Без названия')
              .filter(Boolean);
            const body = names.length === 1
              ? `Отдел: ${names[0]}`
              : `Отделы: ${names.join(', ')}`;
            const title = 'Вы назначены ответственным по табелям';

            await notificationService.createMany([{
              userId: id,
              type: 'timesheet_assigned_departments',
              title,
              body,
              metadata: { departmentIds, path: '/timesheet-hr' },
            }]);
            await pushService.sendGenericNotification([id], title, body, { path: '/timesheet-hr' });
          }
        } catch (notifyError) {
          console.error('approveUser: notify assigned departments error:', notifyError);
        }
      }

      res.json({ success: true, message: 'User approved successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Approve user error:', error);
      res.status(500).json({ success: false, error: 'Failed to approve user' });
    }
  },

  async rejectUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Отклонение заявок доступно только системному администратору' });
        return;
      }

      try {
        await hardDeleteUserCascade(id);
      } catch (deleteError) {
        console.error('Reject user delete error:', deleteError);
        res.status(500).json({ success: false, error: 'Failed to reject user' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_REJECTED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'User rejected and removed' });
    } catch (error) {
      console.error('Reject user error:', error);
      res.status(500).json({ success: false, error: 'Failed to reject user' });
    }
  },

  async deleteUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const scopeCheck = await assertTargetUserInScope(req, id);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
        return;
      }
      try {
        await ensureCriticalAdminAccess({
          removedUserIds: [id],
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Нельзя удалить последнего администратора с критичными правами',
        });
        return;
      }

      try {
        await hardDeleteUserCascade(id);
      } catch (deleteError) {
        console.error('Delete user error:', deleteError);
        res.status(500).json({ success: false, error: 'Failed to delete user' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_DELETED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete user' });
    }
  },

  async confirmUserEmail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const scopeCheck = await assertTargetUserInScope(req, id);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
        return;
      }

      try {
        await localAuthService.updateUserById(id, { emailConfirm: true });
      } catch (error) {
        console.error('Confirm email error:', error);
        res.status(500).json({ success: false, error: 'Failed to confirm email' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'EMAIL_CONFIRMED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'Email confirmed successfully' });
    } catch (error) {
      console.error('Confirm email error:', error);
      res.status(500).json({ success: false, error: 'Failed to confirm email' });
    }
  },

  async peekUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const scopeCheck = await assertTargetUserInScope(req, id);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
        return;
      }

      const row = await queryOne<{
        id: string;
        full_name: string | null;
        email: string | null;
        position_type: string | null;
      }>(
        `SELECT up.id,
                up.full_name,
                au.email,
                sr.code AS position_type
           FROM user_profiles up
           LEFT JOIN app_auth.users au ON au.id = up.id
           LEFT JOIN system_roles sr ON sr.id = up.system_role_id
          WHERE up.id = $1::uuid`,
        [id],
      );
      if (!row) {
        res.status(404).json({ success: false, error: 'Пользователь не найден' });
        return;
      }

      res.json({
        success: true,
        data: {
          id: row.id,
          full_name: row.full_name,
          email: row.email,
          position_type: row.position_type,
        },
      });
    } catch (error) {
      console.error('Peek user error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить пользователя' });
    }
  },

  async generatePasswordResetLink(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const scopeCheck = await assertTargetUserInScope(req, id);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
        return;
      }

      const authRow = await queryOne<{ id: string; email: string | null }>(
        'SELECT id, email FROM app_auth.users WHERE id = $1::uuid',
        [id],
      );
      if (!authRow) {
        res.status(404).json({ success: false, error: 'Пользователь не найден' });
        return;
      }

      const profileRow = await queryOne<{ id: string }>(
        'SELECT id FROM user_profiles WHERE id = $1::uuid',
        [id],
      );
      if (!profileRow) {
        res.status(404).json({ success: false, error: 'Профиль пользователя не найден' });
        return;
      }

      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      try {
        await execute(
          `UPDATE user_profiles
              SET reset_token = $1, reset_token_expires = $2
            WHERE id = $3::uuid`,
          [resetTokenHash, expiresAt.toISOString(), id],
        );
      } catch (updateError) {
        console.error('Admin reset link: update token error:', updateError);
        res.status(500).json({ success: false, error: 'Не удалось создать ссылку для сброса пароля' });
        return;
      }

      const appUrlBase = (process.env.APP_URL || 'https://fot.su10.ru').replace(/\/+$/, '');
      const resetUrl = `${appUrlBase}/reset-password?token=${resetToken}`;

      await auditService.logFromRequest(req, req.user.id, 'PASSWORD_RESET_LINK_GENERATED_BY_ADMIN', {
        entityType: 'user',
        entityId: id,
        details: {
          target_email: authRow.email,
          expires_at: expiresAt.toISOString(),
        },
      });

      res.json({
        success: true,
        resetUrl,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      console.error('Generate password reset link error:', error);
      res.status(500).json({ success: false, error: 'Ошибка при создании ссылки для сброса пароля' });
    }
  },

  async updateUserPosition(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { position_type } = z.object({
        position_type: z.string().min(1)
      }).parse(req.body);

      const scopeCheck = await assertTargetUserInScope(req, id);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
        return;
      }

      const roleAssignment = await resolveActiveRoleAssignment(position_type);
      if (!roleAssignment) {
        res.status(400).json({ success: false, error: 'Роль не найдена или неактивна' });
        return;
      }

      try {
        await ensureCriticalAdminAccess({
          userRoleById: { [id]: roleAssignment.code },
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Нельзя снять последний критичный административный доступ',
        });
        return;
      }

      const beforeProfile = await queryOne<{ full_name: string | null; role_code: string | null }>(
        `SELECT up.full_name, sr.code AS role_code
           FROM user_profiles up
           LEFT JOIN system_roles sr ON sr.id = up.system_role_id
          WHERE up.id = $1::uuid`,
        [id],
      );
      const beforeRoleCode = beforeProfile?.role_code ?? null;

      try {
        await execute(
          'UPDATE user_profiles SET system_role_id = $1::uuid, token_version = token_version + 1 WHERE id = $2::uuid',
          [roleAssignment.id, id],
        );
      } catch (error) {
        console.error('Update position error:', error);
        res.status(500).json({ success: false, error: 'Failed to update position' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'POSITION_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: {
          new_position_type: roleAssignment.code,
          from: beforeRoleCode,
          full_name: beforeProfile?.full_name ?? null,
        },
      });

      invalidateDepartmentScopeCaches();
      emitDepartmentAccessChanged(id);

      res.json({ success: true, message: 'Position updated successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update position error:', error);
      res.status(500).json({ success: false, error: 'Failed to update position' });
    }
  },

  async updateUserName(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { full_name } = z.object({ full_name: z.string().min(2).max(255) }).parse(req.body);

      const scopeCheck = await assertTargetUserInScope(req, id);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
        return;
      }

      try {
        await execute(
          'UPDATE user_profiles SET full_name = $1 WHERE id = $2::uuid',
          [full_name.trim(), id],
        );
      } catch (error) {
        console.error('Update name error:', error);
        res.status(500).json({ success: false, error: 'Failed to update name' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'NAME_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: { full_name },
      });

      res.json({ success: true, message: 'Name updated successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update name error:', error);
      res.status(500).json({ success: false, error: 'Failed to update name' });
    }
  },

  async updateUserEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { employee_id } = z.object({
        employee_id: z.number().int().positive().nullable(),
      }).parse(req.body);

      // Привязка карточки СКУД для company-admin: целевой employee_id (если задан)
      // должен быть в его scope. Существующая привязка пользователя проверяется
      // только если новая = null (отвязка); тогда scope-проверка не нужна.
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        if (employee_id != null) {
          const employeeAllowed = await canAccessEmployeeInScope(req, employee_id);
          if (!employeeAllowed) {
            res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
            return;
          }
        } else {
          const scopeCheck = await assertTargetUserInScope(req, id);
          if (!scopeCheck.ok) {
            res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
            return;
          }
        }
      }

      try {
        await execute(
          'UPDATE user_profiles SET employee_id = $1, token_version = token_version + 1 WHERE id = $2::uuid',
          [employee_id, id],
        );
      } catch (error) {
        console.error('Update employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to update employee link' });
        return;
      }

      invalidateDepartmentScopeCaches();
      emitDepartmentAccessChanged(id);

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to update employee link' });
    }
  },

  async updateUserChatInboundMode(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { chat_inbound_mode } = z.object({
        chat_inbound_mode: z.enum(['open', 'requests_only', 'disabled']),
      }).parse(req.body);

      const scopeCheck = await assertTargetUserInScope(req, id);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
        return;
      }

      try {
        await execute(
          'UPDATE user_profiles SET chat_inbound_mode = $1 WHERE id = $2::uuid',
          [chat_inbound_mode, id],
        );
      } catch (error) {
        console.error('Update chat inbound mode error:', error);
        res.status(500).json({ success: false, error: 'Failed to update chat inbound mode' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'CHAT_INBOUND_MODE_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: { chat_inbound_mode },
      });

      res.json({ success: true, message: 'Chat inbound mode updated successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update chat inbound mode error:', error);
      res.status(500).json({ success: false, error: 'Failed to update chat inbound mode' });
    }
  },

  async updateUserDepartmentAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { department_ids } = updateDepartmentAccessSchema.parse(req.body);
      const normalizedDepartmentIds = [...new Set(department_ids.map(value => value.trim()))];

      const profile = await queryOne<{ employee_id: number | null }>(
        'SELECT employee_id FROM user_profiles WHERE id = $1::uuid',
        [id],
      );

      if (!profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      if (!profile.employee_id) {
        res.status(400).json({
          success: false,
          error: 'Назначить отделы можно только пользователю с привязанной карточкой СКУД. Сначала выберите сотрудника на этой же странице и сохраните привязку.',
        });
        return;
      }

      // Company-admin: целевой сотрудник должен быть в его scope.
      const employeeAllowed = await canAccessEmployeeInScope(req, profile.employee_id);
      if (!employeeAllowed) {
        res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
        return;
      }

      const scopeCheck = await ensureDepartmentIdsInScope(req, normalizedDepartmentIds);
      if (!scopeCheck.ok) {
        res.status(403).json({
          success: false,
          error: 'Некоторые отделы вне вашей зоны доступа',
          details: { out_of_scope_department_ids: scopeCheck.outOfScope },
        });
        return;
      }

      const { missingIds } = await validateDepartmentIds(normalizedDepartmentIds);
      if (missingIds.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Некоторые отделы не найдены',
          details: { missing_department_ids: missingIds },
        });
        return;
      }

      const explicitDepartmentIds = await replaceExplicitDepartmentAccess({
        employeeId: profile.employee_id,
        departmentIds: normalizedDepartmentIds,
        actorUserId: req.user.id,
        source: 'manual_admin_ui',
      });

      const [userFullName, departmentNamesMap] = await Promise.all([
        loadUserFullName(id),
        loadDepartmentNamesMap(explicitDepartmentIds),
      ]);
      const assignedDepartmentNames = explicitDepartmentIds
        .map(deptId => departmentNamesMap.get(deptId))
        .filter((name): name is string => Boolean(name));

      await auditService.logFromRequest(req, req.user.id, 'USER_DEPARTMENT_ACCESS_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: {
          assigned_department_ids: explicitDepartmentIds,
          assigned_department_count: explicitDepartmentIds.length,
          full_name: userFullName,
          assigned_department_names: assignedDepartmentNames,
        },
      });

      invalidateDepartmentScopeCaches();
      emitDepartmentAccessChanged(id);

      res.json({
        success: true,
        data: {
          assigned_department_ids: explicitDepartmentIds,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update user department access error:', error);
      res.status(500).json({ success: false, error: 'Failed to update department access' });
    }
  },

  /**
   * PATCH /api/admin/users/:id/site-supervisor
   * Toggle is_site_supervisor флага на user_profiles.
   */
  async setSiteSupervisor(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { is_site_supervisor } = setSiteSupervisorSchema.parse(req.body);

      const scopeCheck = await assertTargetUserInScope(req, id);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ success: false, error: scopeCheck.error });
        return;
      }

      const updated = await queryOne<{ id: string; is_site_supervisor: boolean }>(
        `UPDATE user_profiles
            SET is_site_supervisor = $1::boolean, updated_at = NOW()
          WHERE id = $2::uuid
        RETURNING id, is_site_supervisor`,
        [is_site_supervisor, id],
      );

      if (!updated) {
        res.status(404).json({ success: false, error: 'Пользователь не найден' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_SITE_SUPERVISOR_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: { is_site_supervisor },
      });

      emitDepartmentAccessChanged(id);

      res.json({ success: true, data: { id: updated.id, is_site_supervisor: updated.is_site_supervisor } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Set site supervisor error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить флаг начальника участка' });
    }
  },

  /**
   * PATCH /api/admin/users/:id/employee-access
   * Полная замена списка сотрудников, прямо назначенных начальнику участка.
   */
  async updateUserEmployeeAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { employee_ids } = updateEmployeeAccessSchema.parse(req.body);
      const normalized = [...new Set(employee_ids)];

      const profile = await queryOne<{ id: string }>(
        'SELECT id FROM user_profiles WHERE id = $1::uuid',
        [id],
      );
      if (!profile) {
        res.status(404).json({ success: false, error: 'Пользователь не найден' });
        return;
      }

      const targetScopeCheck = await assertTargetUserInScope(req, id);
      if (!targetScopeCheck.ok) {
        res.status(targetScopeCheck.status).json({ success: false, error: targetScopeCheck.error });
        return;
      }

      // Каждый назначаемый сотрудник должен быть в scope.
      for (const employeeId of normalized) {
        const allowed = await canAccessEmployeeInScope(req, employeeId);
        if (!allowed) {
          res.status(403).json({ success: false, error: 'Некоторые сотрудники вне вашей зоны доступа' });
          return;
        }
      }

      if (normalized.length > 0) {
        const existing = await query<{ id: number }>(
          'SELECT id FROM employees WHERE id = ANY($1::int[])',
          [normalized],
        );
        const foundIds = new Set(existing.map(row => Number(row.id)));
        const missing = normalized.filter(eid => !foundIds.has(eid));
        if (missing.length > 0) {
          res.status(400).json({
            success: false,
            error: 'Некоторые сотрудники не найдены',
            details: { missing_employee_ids: missing },
          });
          return;
        }
      }

      const savedEmployeeIds = await replaceUserEmployeeAccess({
        userId: id,
        employeeIds: normalized,
        actorUserId: req.user.id,
      });

      const assignedEmployeeNames = savedEmployeeIds.length > 0
        ? await loadEmployeeFullNamesMap(savedEmployeeIds)
        : new Map<number, string>();

      const userFullName = await loadUserFullName(id);

      await auditService.logFromRequest(req, req.user.id, 'USER_EMPLOYEE_ACCESS_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: {
          assigned_employee_ids: savedEmployeeIds,
          assigned_employee_count: savedEmployeeIds.length,
          full_name: userFullName,
          assigned_employee_names: savedEmployeeIds
            .map(eid => assignedEmployeeNames.get(eid))
            .filter((name): name is string => Boolean(name)),
        },
      });

      emitDepartmentAccessChanged(id);

      res.json({ success: true, data: { assigned_employee_ids: savedEmployeeIds } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update user employee access error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить назначения сотрудников' });
    }
  },

  async updateEmployeeDepartmentAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);
      const { department_ids } = updateDepartmentAccessSchema.parse(req.body);
      const normalizedDepartmentIds = uniqueStringValues(department_ids);

      const employee = await queryOne<{ id: number; full_name: string | null }>(
        'SELECT id, full_name FROM employees WHERE id = $1',
        [employeeId],
      );

      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      const employeeAllowed = await canAccessEmployeeInScope(req, employeeId);
      if (!employeeAllowed) {
        res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
        return;
      }

      const scopeCheck = await ensureDepartmentIdsInScope(req, normalizedDepartmentIds);
      if (!scopeCheck.ok) {
        res.status(403).json({
          success: false,
          error: 'Некоторые отделы вне вашей зоны доступа',
          details: { out_of_scope_department_ids: scopeCheck.outOfScope },
        });
        return;
      }

      const { missingIds } = await validateDepartmentIds(normalizedDepartmentIds);
      if (missingIds.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Некоторые отделы не найдены',
          details: { missing_department_ids: missingIds },
        });
        return;
      }

      const explicitDepartmentIds = await replaceExplicitDepartmentAccess({
        employeeId,
        departmentIds: normalizedDepartmentIds,
        actorUserId: req.user.id,
        source: 'manual_admin_ui',
      });

      const departmentNamesMap = await loadDepartmentNamesMap(explicitDepartmentIds);
      const assignedDepartmentNames = explicitDepartmentIds
        .map(deptId => departmentNamesMap.get(deptId))
        .filter((name): name is string => Boolean(name));

      await auditService.logFromRequest(req, req.user.id, 'USER_DEPARTMENT_ACCESS_CHANGED', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          employee_id: employeeId,
          employee_name: employee.full_name,
          employee_full_name: employee.full_name,
          assigned_department_ids: explicitDepartmentIds,
          assigned_department_count: explicitDepartmentIds.length,
          assigned_department_names: assignedDepartmentNames,
        },
      });

      const linkedProfile = await queryOne<{ id: string }>(
        'SELECT id FROM user_profiles WHERE employee_id = $1 LIMIT 1',
        [employeeId],
      );
      invalidateDepartmentScopeCaches();
      emitDepartmentAccessChanged(linkedProfile?.id);

      res.json({
        success: true,
        data: {
          assigned_department_ids: explicitDepartmentIds,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee department access error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить назначения сотрудника' });
    }
  },

  /**
   * GET /api/admin/skud-objects
   * Плоский список активных объектов для UI назначений (только id + name).
   */
  async listSkudObjectsForAssignment(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const rows = await query<{ id: string; name: string }>(
        `SELECT id, name FROM skud_objects WHERE is_active = true ORDER BY name`,
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('List skud-objects for assignment error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить объекты' });
    }
  },

  /**
   * GET /api/admin/employees/:id/skud-objects
   * Возвращает список skud_object_id, к которым приписан сотрудник.
   */
  async getEmployeeSkudObjects(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);

      const employee = await queryOne<{ id: number }>(
        'SELECT id FROM employees WHERE id = $1',
        [employeeId],
      );
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      const allowed = await canAccessEmployeeInScope(req, employeeId);
      if (!allowed) {
        res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
        return;
      }

      const objectIds = await listObjectIdsForEmployee(employeeId);
      res.json({ success: true, data: { object_ids: objectIds } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Get employee skud-objects error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить объекты сотрудника' });
    }
  },

  /**
   * PUT /api/admin/employees/:id/skud-objects
   * Полная замена списка объектов, к которым приписан сотрудник.
   */
  async updateEmployeeSkudObjectAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);
      const { object_ids } = updateEmployeeSkudObjectsSchema.parse(req.body);
      const normalizedObjectIds = [...new Set(object_ids.map(value => value.trim()))];

      const employee = await queryOne<{ id: number; full_name: string | null }>(
        'SELECT id, full_name FROM employees WHERE id = $1',
        [employeeId],
      );
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      const employeeAllowed = await canAccessEmployeeInScope(req, employeeId);
      if (!employeeAllowed) {
        res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
        return;
      }

      if (normalizedObjectIds.length > 0) {
        const existing = await query<{ id: string }>(
          'SELECT id FROM skud_objects WHERE id = ANY($1::uuid[])',
          [normalizedObjectIds],
        );
        const foundIds = new Set(existing.map(row => row.id));
        const missing = normalizedObjectIds.filter(oid => !foundIds.has(oid));
        if (missing.length > 0) {
          res.status(400).json({
            success: false,
            error: 'Некоторые объекты не найдены',
            details: { missing_object_ids: missing },
          });
          return;
        }
      }

      const savedObjectIds = await replaceEmployeeObjectAccess({
        employeeId,
        objectIds: normalizedObjectIds,
        actorUserId: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'EMPLOYEE_SKUD_OBJECT_ACCESS_CHANGED', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          employee_id: employeeId,
          employee_full_name: employee.full_name,
          assigned_object_ids: savedObjectIds,
          assigned_object_count: savedObjectIds.length,
        },
      });

      invalidatePresenceByObjectCache();
      invalidateDashboardCache();

      const linkedProfile = await queryOne<{ id: string }>(
        'SELECT id FROM user_profiles WHERE employee_id = $1 LIMIT 1',
        [employeeId],
      );
      emitDepartmentAccessChanged(linkedProfile?.id);

      res.json({ success: true, data: { object_ids: savedObjectIds } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee skud-object access error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить объекты сотрудника' });
    }
  },

  async searchUnlinkedEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const q = (req.query.q as string || '').trim();
      // include_linked=true — снять фильтр «только без user_profile». Используется
      // при поиске сотрудников для назначения начальнику участка (миграция 090).
      const includeLinked = req.query.include_linked === 'true' || req.query.include_linked === '1';

      if (!q || q.length < 2) {
        res.json({ success: true, data: [] });
        return;
      }

      const accessible = await resolveAccessibleDepartmentIds(req);
      if (accessible !== 'all' && accessible.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      const linkedIds = includeLinked
        ? []
        : (await query<{ employee_id: number | null }>(
            'SELECT employee_id FROM user_profiles WHERE employee_id IS NOT NULL',
          ))
            .map(p => p.employee_id)
            .filter((id): id is number => id !== null);

      const params: unknown[] = [`%${escapeLike(q)}%`];
      let sql = `SELECT id, full_name, org_department_id
                   FROM employees
                  WHERE full_name ILIKE $1
                    AND employment_status = 'active'`;
      if (accessible !== 'all') {
        params.push(accessible);
        sql += ` AND org_department_id = ANY($${params.length}::uuid[])`;
      }
      if (linkedIds.length > 0) {
        params.push(linkedIds);
        sql += ` AND id <> ALL($${params.length}::int[])`;
      }
      sql += ' LIMIT 20';

      let employees: Array<{ id: number; full_name: string; org_department_id: string | null }>;
      try {
        employees = await query<{ id: number; full_name: string; org_department_id: string | null }>(
          sql,
          params,
        );
      } catch (error) {
        logSupabaseError('SearchUnlinkedEmployees', error);
        res.status(500).json({ success: false, error: 'Failed to search employees' });
        return;
      }

      res.json({ success: true, data: employees });
    } catch (error) {
      console.error('Search unlinked employees error:', error);
      res.status(500).json({ success: false, error: 'Failed to search employees' });
    }
  },

  /**
   * GET /api/admin/companies
   * Возвращает список «компаний» = прямых детей корневого узла «Объект».
   * Только системный админ.
   */
  async listCompanies(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
        return;
      }

      const rootRow = await queryOne<{ id: string }>(
        `SELECT id FROM org_departments
          WHERE parent_id IS NULL AND name = $1
          LIMIT 1`,
        ['Объект'],
      );

      if (!rootRow) {
        res.json({ success: true, data: [] });
        return;
      }

      let companies: Array<{ id: string; name: string }>;
      try {
        companies = await query<{ id: string; name: string }>(
          `SELECT id, name FROM org_departments
            WHERE parent_id = $1::uuid AND is_active = true
            ORDER BY name ASC`,
          [rootRow.id],
        );
      } catch (error) {
        logSupabaseError('ListCompanies', error);
        res.status(500).json({ success: false, error: 'Не удалось загрузить компании' });
        return;
      }

      res.json({ success: true, data: companies });
    } catch (error) {
      console.error('List companies error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить компании' });
    }
  },

  /**
   * GET /api/admin/users/:id/companies
   * Возвращает список company_root_ids, привязанных к пользователю.
   * Только системный админ.
   */
  async getUserCompanies(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
        return;
      }

      const { id } = req.params;
      let links: Array<{ company_root_id: string }>;
      try {
        links = await query<{ company_root_id: string }>(
          'SELECT company_root_id FROM user_company_access WHERE user_id = $1::uuid',
          [id],
        );
      } catch (error) {
        logSupabaseError('GetUserCompanies', error);
        res.status(500).json({ success: false, error: 'Не удалось загрузить привязки компаний' });
        return;
      }

      const ids = links.map(row => row.company_root_id);
      res.json({
        success: true,
        data: {
          company_root_ids: ids,
          is_system_admin: ids.length === 0,
        },
      });
    } catch (error) {
      console.error('Get user companies error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить привязки компаний' });
    }
  },

  /**
   * PUT /api/admin/users/:id/companies
   * Полная замена списка company_root_ids у пользователя. Пустой массив →
   * пользователь становится системным админом (видит всё).
   * Только системный админ.
   */
  async replaceUserCompanies(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
        return;
      }

      const { id } = req.params;
      const { company_root_ids } = z.object({
        company_root_ids: z.array(z.string().uuid()).default([]),
      }).parse(req.body);

      const desired = [...new Set(company_root_ids)];

      const profile = await queryOne<{ id: string; system_role_id: string }>(
        'SELECT id, system_role_id FROM user_profiles WHERE id = $1::uuid',
        [id],
      );

      if (!profile) {
        res.status(404).json({ success: false, error: 'Пользователь не найден' });
        return;
      }

      // Привязка к компаниям имеет смысл только для is_admin-ролей.
      const allRoles = await getAllRoles();
      const role = allRoles.find(r => r.id === profile.system_role_id);
      if (!role || !role.is_admin) {
        res.status(400).json({
          success: false,
          error: 'Привязка к компаниям доступна только пользователям с админской ролью',
        });
        return;
      }

      let existing: Array<{ company_root_id: string }>;
      try {
        existing = await query<{ company_root_id: string }>(
          'SELECT company_root_id FROM user_company_access WHERE user_id = $1::uuid',
          [id],
        );
      } catch (existingError) {
        logSupabaseError('ReplaceUserCompanies-load', existingError);
        res.status(500).json({ success: false, error: 'Не удалось обновить привязки компаний' });
        return;
      }

      const existingIds = new Set(existing.map(row => row.company_root_id));
      const desiredSet = new Set(desired);
      const toAdd = desired.filter(rootId => !existingIds.has(rootId));
      const toRemove = [...existingIds].filter(rootId => !desiredSet.has(rootId));

      try {
        await withTransaction(async client => {
          if (toAdd.length > 0) {
            await client.query(
              `INSERT INTO user_company_access (user_id, company_root_id, created_by)
               SELECT $1::uuid, root_id, $2::uuid
                 FROM unnest($3::uuid[]) AS root_id`,
              [id, req.user.id, toAdd],
            );
          }
          if (toRemove.length > 0) {
            await client.query(
              `DELETE FROM user_company_access
                WHERE user_id = $1::uuid
                  AND company_root_id = ANY($2::uuid[])`,
              [id, toRemove],
            );
          }
        });
      } catch (writeError) {
        logSupabaseError('ReplaceUserCompanies-write', writeError);
        const msg = writeError instanceof Error ? writeError.message : 'Не удалось обновить привязки компаний';
        res.status(500).json({ success: false, error: msg });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_COMPANY_ACCESS_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: {
          company_root_ids: desired,
          is_system_admin: desired.length === 0,
        },
      });

      emitDepartmentAccessChanged(id);

      res.json({
        success: true,
        data: {
          company_root_ids: desired,
          is_system_admin: desired.length === 0,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Replace user companies error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить привязки компаний' });
    }
  },
};
