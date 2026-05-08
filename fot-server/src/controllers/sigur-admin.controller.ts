import { Response } from 'express';
import { AxiosError } from 'axios';
import { auditService } from '../services/audit.service.js';
import {
  getSigurEmployeeProfile,
  getSigurEmployeeCardStatuses,
  listSigurDepartmentCounts,
  listSigurDepartmentsTree,
  listSigurEmployees,
} from '../services/sigur-live-admin.service.js';
import {
  createSigurPosition,
  deleteSigurPosition,
  listSigurPositions,
  updateSigurPosition,
} from '../services/sigur-live-positions-crud.service.js';
import {
  batchMoveSigurDepartments,
  createSigurDepartment,
  deleteSigurDepartment,
  deleteSigurDepartmentRecursive,
  updateSigurDepartment,
} from '../services/sigur-live-departments-crud.service.js';
import {
  batchMoveSigurEmployees,
  batchMoveSigurEmployeesStreaming,
  createSigurEmployee,
  deleteSigurEmployee,
  moveSigurEmployee,
  updateSigurEmployee,
} from '../services/sigur-live-employees-crud.service.js';
import {
  assignSigurEmployeeCardBinding,
  removeSigurEmployeeCardBinding,
  replaceSigurEmployeeAccessPoints,
  replaceSigurEmployeeAccessRules,
  updateSigurEmployeeCardBinding,
  updateSigurEmployeeCardExpiration,
} from '../services/sigur-live-cards.service.js';
import { sigurService } from '../services/sigur.service.js';
import {
  seedPositionsLogic,
} from '../services/sigur-sync.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

function parseConnection(value: unknown): 'external' | 'internal' | undefined {
  if (value === 'external' || value === 'internal') return value;
  return undefined;
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function parseBooleanQuery(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'no'].includes(normalized)) return false;
  }
  return null;
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  }
  return 500;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AxiosError && error.response?.data) {
    const data = error.response.data as Record<string, unknown> | string;
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (typeof data === 'object') {
      const msg = data.message ?? data.error ?? data.detail;
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
      const errors = data.errors;
      const errorsKeys = data.errorsKeys;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = String(errors[0]).trim();
        const key = Array.isArray(errorsKeys) && errorsKeys[0] ? ` [${errorsKeys[0]}]` : '';
        if (first) return `${first}${key}`;
      }
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export const sigurAdminController = {
  /**
   * POST /api/sigur/seed-positions
   * Предзаполнение справочника должностей строительной организации
   */
  async seedPositions(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const result = await seedPositionsLogic();
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Sigur seedPositions error:', error);
      res.status(500).json({ success: false, error: 'Ошибка создания справочника должностей' });
    }
  },

  async listDepartmentsTree(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const connection = parseConnection(req.query.connection);
      const data = await listSigurDepartmentsTree(connection);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Sigur admin listDepartmentsTree error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки дерева отделов Sigur' });
    }
  },

  async listDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const connection = parseConnection(req.query.connection);
      const tree = await listSigurDepartmentsTree(connection);
      const flatten = (nodes: typeof tree): typeof tree =>
        nodes.flatMap(node => [
          { ...node, children: undefined },
          ...(node.children ? flatten(node.children) : []),
        ]);
      res.json({ success: true, data: flatten(tree) });
    } catch (error) {
      console.error('Sigur admin listDepartments error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки отделов Sigur' });
    }
  },

  async listDepartmentCounts(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const connection = parseConnection(req.query.connection);
      const data = await listSigurDepartmentCounts(connection);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Sigur admin listDepartmentCounts error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки счётчиков отделов Sigur' });
    }
  },

  async createDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        res.status(400).json({ success: false, error: 'name обязателен' });
        return;
      }

      const parentId = req.body.parentId == null ? null : parseInteger(req.body.parentId);
      if (req.body.parentId != null && parentId == null) {
        res.status(400).json({ success: false, error: 'parentId должен быть целым числом или null' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await createSigurDepartment({ name, parentId }, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_department',
        entityId: String(data.id),
        details: { action: 'create', name: data.name, parentId: data.parentId },
      });

      res.status(201).json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin createDepartment error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка создания отдела Sigur') });
    }
  },

  async updateDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departmentId = parseInteger(req.params.sigurDepartmentId);
      if (!departmentId) {
        res.status(400).json({ success: false, error: 'Некорректный ID отдела' });
        return;
      }

      const payload: { name?: string; parentId?: number | null } = {};
      if (req.body.name !== undefined) {
        if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
          res.status(400).json({ success: false, error: 'name должен быть непустой строкой' });
          return;
        }
        payload.name = req.body.name.trim();
      }

      if (req.body.parentId !== undefined) {
        const parentId = req.body.parentId == null ? null : parseInteger(req.body.parentId);
        if (req.body.parentId != null && parentId == null) {
          res.status(400).json({ success: false, error: 'parentId должен быть целым числом или null' });
          return;
        }
        payload.parentId = parentId;
      }

      const connection = parseConnection(req.body.connection);
      const data = await updateSigurDepartment(departmentId, payload, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_department',
        entityId: String(data.id),
        details: { action: 'update', ...payload },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin updateDepartment error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка обновления отдела Sigur') });
    }
  },

  async deleteDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departmentId = parseInteger(req.params.sigurDepartmentId);
      if (!departmentId) {
        res.status(400).json({ success: false, error: 'Некорректный ID отдела' });
        return;
      }

      const connection = parseConnection(req.body?.connection ?? req.query.connection);
      await deleteSigurDepartment(departmentId, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_department',
        entityId: String(departmentId),
        details: { action: 'delete' },
      });

      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin deleteDepartment error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка удаления отдела Sigur') });
    }
  },

  async batchMoveDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { departmentIds, targetParentId } = req.body as {
        departmentIds?: unknown;
        targetParentId?: unknown;
      };

      if (!Array.isArray(departmentIds)) {
        res.status(400).json({ success: false, error: 'departmentIds должен быть массивом' });
        return;
      }

      const parsedDepartmentIds = departmentIds
        .map(value => parseInteger(value))
        .filter((value): value is number => !!value);
      const parsedTargetParentId = targetParentId == null ? null : parseInteger(targetParentId);
      if (targetParentId != null && parsedTargetParentId == null) {
        res.status(400).json({ success: false, error: 'targetParentId должен быть целым числом или null' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await batchMoveSigurDepartments(parsedDepartmentIds, parsedTargetParentId, connection);
      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin batchMoveDepartments error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка массового перемещения отделов Sigur') });
    }
  },

  async deleteDepartmentRecursive(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departmentId = parseInteger(req.params.sigurDepartmentId);
      if (!departmentId) {
        res.status(400).json({ success: false, error: 'Некорректный ID отдела' });
        return;
      }

      const connection = parseConnection(req.body?.connection ?? req.query.connection);
      const data = await deleteSigurDepartmentRecursive(departmentId, connection);
      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin deleteDepartmentRecursive error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка удаления ветки отдела Sigur') });
    }
  },

  async listEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departmentId = req.query.departmentId == null ? null : parseInteger(req.query.departmentId);
      if (req.query.departmentId != null && departmentId == null) {
        res.status(400).json({ success: false, error: 'departmentId должен быть целым числом' });
        return;
      }

      const search = typeof req.query.search === 'string' ? req.query.search : null;
      const blocked = parseBooleanQuery(req.query.blocked);
      if (blocked === null) {
        res.status(400).json({ success: false, error: 'blocked должен быть boolean' });
        return;
      }
      const page = req.query.page == null ? 1 : parseInteger(req.query.page);
      const pageSize = req.query.pageSize == null ? 200 : parseInteger(req.query.pageSize);
      if (page == null || page < 1) {
        res.status(400).json({ success: false, error: 'page должен быть целым числом больше 0' });
        return;
      }
      if (pageSize == null || pageSize < 1) {
        res.status(400).json({ success: false, error: 'pageSize должен быть целым числом больше 0' });
        return;
      }
      const connection = parseConnection(req.query.connection);
      const data = await listSigurEmployees(
        { departmentId, search, blocked },
        { page, pageSize },
        connection,
      );
      const cacheMeta = sigurService.getEmployeesCacheMeta();
      res.json({
        success: true,
        data: data.items,
        meta: {
          total: data.total,
          page: data.page,
          pageSize: data.pageSize,
          cacheCount: cacheMeta.count,
          cacheLoading: cacheMeta.loading,
          cacheComplete: cacheMeta.complete,
        },
      });
    } catch (error) {
      console.error('Sigur admin listEmployees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки сотрудников Sigur' });
    }
  },

  async listPositions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const connection = parseConnection(req.query.connection);
      const data = await listSigurPositions(connection);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Sigur admin listPositions error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки должностей Sigur' });
    }
  },

  async createPosition(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        res.status(400).json({ success: false, error: 'name обязателен' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await createSigurPosition(name, connection);
      res.status(201).json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin createPosition error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка создания должности Sigur') });
    }
  },

  async updatePosition(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurPositionId = parseInteger(req.params.sigurPositionId);
      if (!sigurPositionId) {
        res.status(400).json({ success: false, error: 'Некорректный ID должности' });
        return;
      }
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        res.status(400).json({ success: false, error: 'name обязателен' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await updateSigurPosition(sigurPositionId, name, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_position',
        entityId: String(sigurPositionId),
        details: { action: 'update', name: data.name },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin updatePosition error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка редактирования должности Sigur') });
    }
  },

  async deletePosition(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurPositionId = parseInteger(req.params.sigurPositionId);
      if (!sigurPositionId) {
        res.status(400).json({ success: false, error: 'Некорректный ID должности' });
        return;
      }

      const connection = parseConnection(req.query.connection);
      await deleteSigurPosition(sigurPositionId, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_position',
        entityId: String(sigurPositionId),
        details: { action: 'delete' },
      });

      res.json({ success: true });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin deletePosition error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка удаления должности Sigur') });
    }
  },

  async getEmployeeProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      if (!sigurEmployeeId) {
        res.status(400).json({ success: false, error: 'Некорректный ID сотрудника' });
        return;
      }

      const connection = parseConnection(req.query.connection);
      const includeAccessPointCatalog = parseBooleanQuery(req.query.includeAccessPointCatalog);
      if (includeAccessPointCatalog === null) {
        res.status(400).json({ success: false, error: 'includeAccessPointCatalog должен быть boolean' });
        return;
      }
      const data = await getSigurEmployeeProfile(
        sigurEmployeeId,
        { includeAccessPointCatalog: includeAccessPointCatalog === true },
        connection,
      );
      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin getEmployeeProfile error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка загрузки профиля сотрудника Sigur') });
    }
  },

  async getEmployeeCardStatuses(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const rawEmployeeIds = typeof req.query.employeeIds === 'string' ? req.query.employeeIds : '';
      const employeeIds = rawEmployeeIds
        .split(',')
        .map(value => parseInteger(value.trim()))
        .filter((value): value is number => !!value);

      if (employeeIds.length === 0) {
        res.status(400).json({ success: false, error: 'employeeIds обязателен' });
        return;
      }

      const connection = parseConnection(req.query.connection);
      const data = await getSigurEmployeeCardStatuses(employeeIds, connection);
      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin getEmployeeCardStatuses error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка загрузки статусов пропусков Sigur') });
    }
  },

  async createEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const departmentId = parseInteger(req.body.departmentId);
      if (!name || !departmentId) {
        res.status(400).json({ success: false, error: 'name и departmentId обязательны' });
        return;
      }

      const positionId = req.body.positionId == null ? null : parseInteger(req.body.positionId);
      const blocked = req.body.blocked == null ? null : Boolean(req.body.blocked);
      const tabId = typeof req.body.tabId === 'string' ? req.body.tabId.trim() : null;
      const description = typeof req.body.description === 'string' ? req.body.description : null;
      const connection = parseConnection(req.body.connection);

      const data = await createSigurEmployee({
        name,
        departmentId,
        positionId,
        blocked,
        tabId,
        description,
      }, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(data.sigurEmployeeId),
        details: { action: 'create', departmentId, positionId, blocked, tabId },
      });

      res.status(201).json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin createEmployee error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка создания сотрудника Sigur') });
    }
  },

  async updateEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      if (!sigurEmployeeId) {
        res.status(400).json({ success: false, error: 'Некорректный ID сотрудника' });
        return;
      }

      const positionId = req.body.positionId === undefined
        ? undefined
        : (req.body.positionId == null ? null : parseInteger(req.body.positionId));
      const departmentId = req.body.departmentId === undefined
        ? undefined
        : (req.body.departmentId == null ? null : parseInteger(req.body.departmentId));

      if (req.body.positionId !== undefined && req.body.positionId != null && positionId == null) {
        res.status(400).json({ success: false, error: 'positionId должен быть целым числом или null' });
        return;
      }

      if (req.body.departmentId !== undefined && req.body.departmentId != null && departmentId == null) {
        res.status(400).json({ success: false, error: 'departmentId должен быть целым числом или null' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await updateSigurEmployee(
        sigurEmployeeId,
        {
          name: typeof req.body.name === 'string' ? req.body.name.trim() : undefined,
          departmentId,
          positionId,
          tabId: req.body.tabId === undefined
            ? undefined
            : (typeof req.body.tabId === 'string' ? req.body.tabId.trim() : null),
          description: req.body.description === undefined
            ? undefined
            : (typeof req.body.description === 'string' ? req.body.description : null),
          blocked: req.body.blocked === undefined ? undefined : Boolean(req.body.blocked),
        },
        connection,
      );

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(sigurEmployeeId),
        details: { action: 'update' },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin updateEmployee error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка обновления сотрудника Sigur') });
    }
  },

  async deleteEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      if (!sigurEmployeeId) {
        res.status(400).json({ success: false, error: 'Некорректный ID сотрудника' });
        return;
      }

      const connection = parseConnection(req.body?.connection ?? req.query.connection);
      await deleteSigurEmployee(sigurEmployeeId, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(sigurEmployeeId),
        details: { action: 'delete' },
      });

      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin deleteEmployee error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка удаления сотрудника Sigur') });
    }
  },

  async blockEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      if (!sigurEmployeeId) {
        res.status(400).json({ success: false, error: 'Некорректный ID сотрудника' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await updateSigurEmployee(sigurEmployeeId, { blocked: true }, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(sigurEmployeeId),
        details: { action: 'block' },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin blockEmployee error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка блокировки сотрудника Sigur') });
    }
  },

  async unblockEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      if (!sigurEmployeeId) {
        res.status(400).json({ success: false, error: 'Некорректный ID сотрудника' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await updateSigurEmployee(sigurEmployeeId, { blocked: false }, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(sigurEmployeeId),
        details: { action: 'unblock' },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin unblockEmployee error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка разблокировки сотрудника Sigur') });
    }
  },

  async moveEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      const departmentId = parseInteger(req.body.departmentId);
      if (!sigurEmployeeId || !departmentId) {
        res.status(400).json({ success: false, error: 'sigurEmployeeId и departmentId обязательны' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await moveSigurEmployee(sigurEmployeeId, departmentId, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(sigurEmployeeId),
        details: { action: 'move', departmentId },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin moveEmployee error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка перевода сотрудника в отдел Sigur') });
    }
  },

  async batchMoveEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { employeeIds, departmentId } = req.body as { employeeIds?: unknown; departmentId?: unknown };
      if (!Array.isArray(employeeIds)) {
        res.status(400).json({ success: false, error: 'employeeIds должен быть массивом' });
        return;
      }

      const parsedEmployeeIds = employeeIds
        .map(value => parseInteger(value))
        .filter((value): value is number => !!value);
      const parsedDepartmentId = parseInteger(departmentId);
      if (!parsedDepartmentId) {
        res.status(400).json({ success: false, error: 'departmentId обязателен' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await batchMoveSigurEmployees(parsedEmployeeIds, parsedDepartmentId, connection);
      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin batchMoveEmployees error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка массового перемещения сотрудников Sigur') });
    }
  },

  async batchMoveEmployeesStream(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { employeeIds, departmentId } = req.body as { employeeIds?: unknown; departmentId?: unknown };
    if (!Array.isArray(employeeIds)) {
      res.status(400).json({ success: false, error: 'employeeIds должен быть массивом' });
      return;
    }

    const parsedEmployeeIds = employeeIds
      .map(value => parseInteger(value))
      .filter((value): value is number => !!value);
    const parsedDepartmentId = parseInteger(departmentId);
    if (!parsedDepartmentId) {
      res.status(400).json({ success: false, error: 'departmentId обязателен' });
      return;
    }

    const connection = parseConnection(req.body.connection);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const keepAliveTimer = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15_000);
    res.on('close', () => clearInterval(keepAliveTimer));

    const send = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await batchMoveSigurEmployeesStreaming(
        parsedEmployeeIds,
        parsedDepartmentId,
        connection,
        send,
      );
      send({ type: 'done', ...result });
    } catch (error) {
      console.error('Sigur admin batchMoveEmployeesStream error:', error);
      send({
        type: 'error',
        error: getErrorMessage(error, 'Ошибка массового перемещения сотрудников Sigur'),
      });
    } finally {
      clearInterval(keepAliveTimer);
      res.end();
    }
  },

  async saveEmployeeAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      if (!sigurEmployeeId) {
        res.status(400).json({ success: false, error: 'Некорректный ID сотрудника' });
        return;
      }

      const { accessPointIds } = req.body as { accessPointIds?: unknown };
      if (!Array.isArray(accessPointIds) || accessPointIds.some(value => !Number.isInteger(value))) {
        res.status(400).json({ success: false, error: 'accessPointIds должен быть массивом целых чисел' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      console.log('[Sigur access-points] incoming PUT', {
        sigurEmployeeId,
        accessPointIds,
        connection: connection || 'default',
      });
      const data = await replaceSigurEmployeeAccessPoints(sigurEmployeeId, accessPointIds as number[], connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(sigurEmployeeId),
        details: {
          action: 'save_access_points',
          accessPointIds,
          addedIds: data.addedIds,
          removedIds: data.removedIds,
        },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin saveEmployeeAccessPoints error:', error);
      console.error('[Sigur access-points] context:', {
        sigurEmployeeId: req.params.sigurEmployeeId,
        accessPointIds: (req.body as { accessPointIds?: unknown })?.accessPointIds,
      });
      const debug: Record<string, unknown> = {};
      const sigurEmployeeIdParsed = parseInteger(req.params.sigurEmployeeId);
      if (sigurEmployeeIdParsed) {
        try {
          const sample = await sigurService.getEmployeeAccessPointBindings(
            { employeeId: sigurEmployeeIdParsed },
            parseConnection(req.body?.connection),
          );
          debug.currentBindingSample = Array.isArray(sample) && sample.length > 0 ? sample[0] : null;
          debug.currentBindingsCount = Array.isArray(sample) ? sample.length : 0;
        } catch (sampleError) {
          debug.currentBindingSampleError = sampleError instanceof Error ? sampleError.message : String(sampleError);
        }
      }
      if (error instanceof AxiosError) {
        const data = error.response?.data as Record<string, unknown> | undefined;
        console.error('[Sigur access-points] method=', error.config?.method, 'url=', error.config?.url);
        console.error('[Sigur access-points] status=', error.response?.status);
        console.error('[Sigur access-points] request body=', error.config?.data);
        console.error('[Sigur access-points] errors=', JSON.stringify(data?.errors));
        console.error('[Sigur access-points] errorsKeys=', JSON.stringify(data?.errorsKeys));
        console.error('[Sigur access-points] full data=', JSON.stringify(data));
        debug.sigurMethod = error.config?.method;
        debug.sigurUrl = error.config?.url;
        debug.sigurStatus = error.response?.status;
        debug.sigurRequestBody = (() => {
          try {
            return typeof error.config?.data === 'string' ? JSON.parse(error.config.data) : error.config?.data;
          } catch {
            return error.config?.data;
          }
        })();
        debug.sigurResponse = data;
      }
      res.status(status).json({
        success: false,
        error: getErrorMessage(error, 'Ошибка сохранения точек доступа Sigur'),
        ...(Object.keys(debug).length > 0 ? { debug } : {}),
      });
    }
  },

  async saveEmployeeAccessRules(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      if (!sigurEmployeeId) {
        res.status(400).json({ success: false, error: 'Некорректный ID сотрудника' });
        return;
      }

      const { accessRuleIds } = req.body as { accessRuleIds?: unknown };
      if (!Array.isArray(accessRuleIds) || accessRuleIds.some(value => !Number.isInteger(value))) {
        res.status(400).json({ success: false, error: 'accessRuleIds должен быть массивом целых чисел' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await replaceSigurEmployeeAccessRules(sigurEmployeeId, accessRuleIds as number[], connection);
      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin saveEmployeeAccessRules error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка сохранения режимов доступа Sigur') });
    }
  },

  async updateEmployeeCardExpiration(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      const cardId = parseInteger(req.params.cardId);
      const expirationDate = typeof req.body.expirationDate === 'string' ? req.body.expirationDate : '';

      if (!sigurEmployeeId || !cardId || !expirationDate) {
        res.status(400).json({ success: false, error: 'sigurEmployeeId, cardId и expirationDate обязательны' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const data = await updateSigurEmployeeCardExpiration(sigurEmployeeId, cardId, expirationDate, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(sigurEmployeeId),
        details: {
          action: 'update_card_expiration',
          cardId,
          expirationDate: data.expirationDate,
        },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin updateEmployeeCardExpiration error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка обновления срока действия карты Sigur') });
    }
  },

  async updateEmployeeCardBinding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      const cardId = parseInteger(req.params.cardId);
      const startDate = typeof req.body.startDate === 'string' ? req.body.startDate : '';
      const expirationDate = typeof req.body.expirationDate === 'string' ? req.body.expirationDate : '';

      if (!sigurEmployeeId || !cardId || !startDate || !expirationDate) {
        res.status(400).json({ success: false, error: 'sigurEmployeeId, cardId, startDate и expirationDate обязательны' });
        return;
      }

      const connection = parseConnection(req.body.connection);
      const format = typeof req.body.format === 'string' && req.body.format ? req.body.format : undefined;
      const data = await updateSigurEmployeeCardBinding(sigurEmployeeId, cardId, startDate, expirationDate, connection, format);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_employee',
        entityId: String(sigurEmployeeId),
        details: {
          action: 'update_card_binding',
          cardId,
          startDate: data.startDate,
          expirationDate: data.expirationDate,
        },
      });

      res.json({ success: true, data });
    } catch (error) {
      const status = getErrorStatus(error);
      if (error instanceof AxiosError) {
        const data = error.response?.data as Record<string, unknown> | undefined;
        console.error('[Sigur 400] method=', error.config?.method, 'url=', error.config?.url);
        console.error('[Sigur 400] status=', error.response?.status);
        console.error('[Sigur 400] request body=', error.config?.data);
        console.error('[Sigur 400] errors=', JSON.stringify(data?.errors));
        console.error('[Sigur 400] errorsKeys=', JSON.stringify(data?.errorsKeys));
        console.error('[Sigur 400] full data=', JSON.stringify(data));
      }
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка обновления дат карты Sigur') });
    }
  },

  async assignEmployeeCardBinding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      if (!sigurEmployeeId) {
        res.status(400).json({ success: false, error: 'sigurEmployeeId обязателен' });
        return;
      }

      const body = (req.body || {}) as Record<string, unknown>;
      const candidates: string[] = [];
      const uid = typeof body.uid === 'string' ? body.uid.trim() : '';
      if (uid) candidates.push(uid);
      if (Array.isArray(body.uids)) {
        for (const item of body.uids) {
          if (typeof item === 'string' && item.trim() && !candidates.includes(item.trim())) {
            candidates.push(item.trim());
          }
        }
      }
      if (candidates.length === 0) {
        res.status(400).json({ success: false, error: 'uid обязателен' });
        return;
      }

      const expirationDate = typeof body.expirationDate === 'string' ? body.expirationDate : undefined;
      const connection = parseConnection(body.connection);
      const result = await assignSigurEmployeeCardBinding(sigurEmployeeId, candidates, expirationDate, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_card_binding',
        entityId: `${sigurEmployeeId}:${result.card.cardId}`,
        details: {
          source: 'sigur-live-sidebar',
          uid: candidates[0],
          uids: candidates,
          sigurEmployeeId,
          cardId: result.card.cardId,
          startDate: result.card.startDate,
          expirationDate: result.card.expirationDate,
          replacedSigurEmployeeId: result.previousSigurEmployeeId,
        },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin assignEmployeeCardBinding error:', error);
      const message = error instanceof Error ? error.message : 'Ошибка привязки карты Sigur';
      res.status(status === 500 ? 400 : status).json({ success: false, error: getErrorMessage(error, message) });
    }
  },

  async deleteEmployeeCardBinding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sigurEmployeeId = parseInteger(req.params.sigurEmployeeId);
      const cardId = parseInteger(req.params.cardId);
      if (!sigurEmployeeId || !cardId) {
        res.status(400).json({ success: false, error: 'sigurEmployeeId и cardId обязательны' });
        return;
      }

      const connection = parseConnection(req.body?.connection);
      const result = await removeSigurEmployeeCardBinding(sigurEmployeeId, cardId, connection);

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_card_binding',
        entityId: `${sigurEmployeeId}:${cardId}`,
        details: {
          action: 'remove_card_binding',
          sigurEmployeeId,
          cardId,
        },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      const status = getErrorStatus(error);
      console.error('Sigur admin deleteEmployeeCardBinding error:', error);
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Ошибка удаления карты Sigur') });
    }
  },
};
