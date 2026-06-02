import { Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { getIo } from '../socket/io-instance.js';
import {
  canAccessDepartmentInScope,
  canAccessEmployeeInScope,
  resolveAccessibleDepartmentIds,
} from '../services/data-scope.service.js';
import {
  listDepartmentObjectAssignments,
  listEmployeeObjectAssignments,
  listTimekeeperObjectAccess,
  listTimekeeperFolderAccess,
  replaceDepartmentObjectAssignment,
  replaceEmployeeObjectAssignment,
  replaceTimekeeperObjectAccess,
  replaceTimekeeperFolderAccess,
} from '../services/object-assignment.service.js';

const objectIdsSchema = z.object({
  object_ids: z.array(z.string().uuid()).default([]),
});

const folderIdsSchema = z.object({
  department_ids: z.array(z.string().uuid()).default([]),
});

/** Возвращает список несуществующих org_department_id (для 400). */
async function findMissingDepartmentIds(departmentIds: string[]): Promise<string[]> {
  if (departmentIds.length === 0) return [];
  const existing = await query<{ id: string }>(
    'SELECT id FROM org_departments WHERE id = ANY($1::uuid[])',
    [departmentIds],
  );
  const found = new Set(existing.map(r => r.id));
  return departmentIds.filter(id => !found.has(id));
}

/** Возвращает список несуществующих skud_object_id (для 400). */
async function findMissingObjectIds(objectIds: string[]): Promise<string[]> {
  if (objectIds.length === 0) return [];
  const existing = await query<{ id: string }>(
    'SELECT id FROM skud_objects WHERE id = ANY($1::uuid[])',
    [objectIds],
  );
  const found = new Set(existing.map(r => r.id));
  return objectIds.filter(id => !found.has(id));
}

function emitAccessChanged(targetUserId: string | null | undefined): void {
  if (!targetUserId) return;
  const io = getIo();
  if (!io) return;
  io.to(`user:${targetUserId}`).emit('profile:access_changed');
}

export const objectAssignmentController = {
  /**
   * GET /api/admin/object-assignments
   * Карты назначений «сущность → объекты входа» для страницы назначения.
   * Возвращает только существующие (active) строки. Скоупится доступом админа.
   */
  async getObjectAssignments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const accessible = await resolveAccessibleDepartmentIds(req);
      const [deptRows, empRows] = await Promise.all([
        listDepartmentObjectAssignments(),
        listEmployeeObjectAssignments(),
      ]);

      let scopedDeptRows = deptRows;
      let scopedEmpRows = empRows;

      if (accessible !== 'all') {
        const accessibleSet = new Set(accessible);
        scopedDeptRows = deptRows.filter(r => accessibleSet.has(r.org_department_id));

        const empIds = [...new Set(empRows.map(r => r.employee_id))];
        const empDeptMap = new Map<number, string | null>();
        if (empIds.length > 0) {
          const rows = await query<{ id: number | string; org_department_id: string | null }>(
            'SELECT id, org_department_id FROM employees WHERE id = ANY($1::bigint[])',
            [empIds],
          );
          rows.forEach(r => empDeptMap.set(Number(r.id), r.org_department_id));
        }
        scopedEmpRows = empRows.filter(r => {
          const deptId = empDeptMap.get(r.employee_id);
          return deptId != null && accessibleSet.has(deptId);
        });
      }

      const departmentObjects: Record<string, string[]> = {};
      for (const row of scopedDeptRows) {
        (departmentObjects[row.org_department_id] ??= []).push(row.skud_object_id);
      }
      const employeeObjects: Record<string, string[]> = {};
      for (const row of scopedEmpRows) {
        (employeeObjects[String(row.employee_id)] ??= []).push(row.skud_object_id);
      }

      res.json({ success: true, data: { department_objects: departmentObjects, employee_objects: employeeObjects } });
    } catch (error) {
      console.error('Get object-assignments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить назначения объектов' });
    }
  },

  /**
   * PUT /api/admin/departments/:id/object-assignment
   * Полная замена объектов, назначенных отделу/бригаде.
   */
  async updateDepartmentObjectAssignment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departmentId = z.string().uuid().parse(req.params.id);
      const { object_ids } = objectIdsSchema.parse(req.body);

      const department = await queryOne<{ id: string; name: string | null }>(
        'SELECT id, name FROM org_departments WHERE id = $1::uuid',
        [departmentId],
      );
      if (!department) {
        res.status(404).json({ success: false, error: 'Отдел не найден' });
        return;
      }
      if (!(await canAccessDepartmentInScope(req, departmentId))) {
        res.status(403).json({ success: false, error: 'Отдел вне вашей зоны доступа' });
        return;
      }

      const missing = await findMissingObjectIds(object_ids);
      if (missing.length > 0) {
        res.status(400).json({ success: false, error: 'Некоторые объекты не найдены', details: { missing_object_ids: missing } });
        return;
      }

      const saved = await replaceDepartmentObjectAssignment({
        departmentId,
        objectIds: object_ids,
        actorUserId: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'DEPARTMENT_OBJECT_ASSIGNMENT_CHANGED', {
        entityType: 'org_department',
        entityId: departmentId,
        details: { department_id: departmentId, department_name: department.name, assigned_object_ids: saved },
      });

      res.json({ success: true, data: { object_ids: saved } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update department object-assignment error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить объекты отдела' });
    }
  },

  /**
   * PUT /api/admin/employees/:id/object-assignment
   * Полная замена объектов, назначенных сотруднику явно (мультиобъектные).
   */
  async updateEmployeeObjectAssignment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);
      const { object_ids } = objectIdsSchema.parse(req.body);

      const employee = await queryOne<{ id: number; full_name: string | null }>(
        'SELECT id, full_name FROM employees WHERE id = $1',
        [employeeId],
      );
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
        return;
      }

      const missing = await findMissingObjectIds(object_ids);
      if (missing.length > 0) {
        res.status(400).json({ success: false, error: 'Некоторые объекты не найдены', details: { missing_object_ids: missing } });
        return;
      }

      const saved = await replaceEmployeeObjectAssignment({
        employeeId,
        objectIds: object_ids,
        actorUserId: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'EMPLOYEE_OBJECT_ASSIGNMENT_CHANGED', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: { employee_id: employeeId, employee_full_name: employee.full_name, assigned_object_ids: saved },
      });

      res.json({ success: true, data: { object_ids: saved } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee object-assignment error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить объекты сотрудника' });
    }
  },

  /**
   * GET /api/admin/users/:id/timekeeper-objects
   * Объекты, назначенные табельщице.
   */
  async getUserTimekeeperObjects(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = z.string().uuid().parse(req.params.id);
      const objectIds = await listTimekeeperObjectAccess(userId);
      res.json({ success: true, data: { object_ids: objectIds } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Get timekeeper-objects error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить объекты табельщицы' });
    }
  },

  /**
   * PUT /api/admin/users/:id/timekeeper-objects
   * Полная замена объектов, назначенных табельщице.
   */
  async updateUserTimekeeperObjects(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = z.string().uuid().parse(req.params.id);
      const { object_ids } = objectIdsSchema.parse(req.body);

      const profile = await queryOne<{ id: string; full_name: string | null }>(
        'SELECT id, full_name FROM user_profiles WHERE id = $1::uuid',
        [userId],
      );
      if (!profile) {
        res.status(404).json({ success: false, error: 'Пользователь не найден' });
        return;
      }

      const missing = await findMissingObjectIds(object_ids);
      if (missing.length > 0) {
        res.status(400).json({ success: false, error: 'Некоторые объекты не найдены', details: { missing_object_ids: missing } });
        return;
      }

      const saved = await replaceTimekeeperObjectAccess({
        timekeeperUserId: userId,
        objectIds: object_ids,
        actorUserId: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'USER_TIMEKEEPER_OBJECT_ACCESS_CHANGED', {
        entityType: 'user',
        entityId: userId,
        details: { user_id: userId, user_full_name: profile.full_name, assigned_object_ids: saved },
      });

      emitAccessChanged(userId);

      res.json({ success: true, data: { object_ids: saved } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update timekeeper-objects error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить объекты табельщицы' });
    }
  },

  /**
   * GET /api/admin/users/:id/timekeeper-folders
   * Папки (отделы оргструктуры), сужающие скоуп табельщицы.
   */
  async getUserTimekeeperFolders(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = z.string().uuid().parse(req.params.id);
      const departmentIds = await listTimekeeperFolderAccess(userId);
      res.json({ success: true, data: { department_ids: departmentIds } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Get timekeeper-folders error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить папки табельщицы' });
    }
  },

  /**
   * PUT /api/admin/users/:id/timekeeper-folders
   * Полная замена папок табельщицы.
   */
  async updateUserTimekeeperFolders(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = z.string().uuid().parse(req.params.id);
      const { department_ids } = folderIdsSchema.parse(req.body);

      const profile = await queryOne<{ id: string; full_name: string | null }>(
        'SELECT id, full_name FROM user_profiles WHERE id = $1::uuid',
        [userId],
      );
      if (!profile) {
        res.status(404).json({ success: false, error: 'Пользователь не найден' });
        return;
      }

      const missing = await findMissingDepartmentIds(department_ids);
      if (missing.length > 0) {
        res.status(400).json({ success: false, error: 'Некоторые отделы не найдены', details: { missing_department_ids: missing } });
        return;
      }

      const saved = await replaceTimekeeperFolderAccess({
        timekeeperUserId: userId,
        departmentIds: department_ids,
        actorUserId: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'USER_TIMEKEEPER_FOLDER_ACCESS_CHANGED', {
        entityType: 'user',
        entityId: userId,
        details: { user_id: userId, user_full_name: profile.full_name, assigned_department_ids: saved },
      });

      emitAccessChanged(userId);

      res.json({ success: true, data: { department_ids: saved } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update timekeeper-folders error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить папки табельщицы' });
    }
  },
};
