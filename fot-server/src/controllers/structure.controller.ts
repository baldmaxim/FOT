import { Response } from 'express';
import * as Sentry from '@sentry/node';
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { getKnownArchiveDepartment, isProtectedArchiveDepartment } from '../services/employee-archive-department.service.js';
import { invalidateDeptTreeCache } from '../services/skud-shared.service.js';
import { resolveAccessibleDepartmentIds, resolveCompanyScope } from '../services/data-scope.service.js';
import type {
  AuthenticatedRequest,
  OrgDepartment,
  OrgDepartmentEncrypted,
  OrgDepartmentKind,
  OrgDepartmentNode,
} from '../types/index.js';
import { ORG_DEPARTMENT_KINDS } from '../types/index.js';
import { detectDepartmentKindFromName } from '../utils/department-kind.utils.js';

interface IHttpError extends Error {
  status?: number;
}

function createHttpError(status: number, message: string): IHttpError {
  const error = new Error(message) as IHttpError;
  error.status = status;
  return error;
}

function decryptDepartment(encrypted: OrgDepartmentEncrypted): OrgDepartment {
  return {
    id: encrypted.id,
    parent_id: encrypted.parent_id,
    sigur_department_id: encrypted.sigur_department_id,
    name: encrypted.name || '',
    description: encrypted.description || null,
    sort_order: encrypted.sort_order,
    is_active: encrypted.is_active,
    kind: encrypted.kind ?? 'department',
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

function parseKind(value: unknown): OrgDepartmentKind | null {
  if (typeof value !== 'string') return null;
  return (ORG_DEPARTMENT_KINDS as readonly string[]).includes(value)
    ? (value as OrgDepartmentKind)
    : null;
}

function buildDepartmentTree(
  allDepts: OrgDepartment[],
  parentId: string | null,
): OrgDepartmentNode[] {
  // O(N) построение через индекс parent_id → children. Раньше .filter() на каждом узле
  // давал O(N²) и заметно тяжелел при ~1000+ отделов под пиковой нагрузкой.
  const childrenByParent = buildChildrenMap(allDepts);
  const recurse = (currentParentId: string | null): OrgDepartmentNode[] => {
    const direct = childrenByParent.get(currentParentId) ?? [];
    return [...direct]
      .sort((left, right) => left.sort_order - right.sort_order)
      .map(department => ({
        ...department,
        children: recurse(department.id),
      }));
  };
  return recurse(parentId);
}

async function loadAllActiveDepartments(): Promise<OrgDepartment[]> {
  const rows = await query<OrgDepartmentEncrypted>(
    `SELECT id, parent_id, sigur_department_id, name, description, sort_order,
            is_active, kind, created_at, updated_at
       FROM org_departments
      WHERE is_active = true
      ORDER BY sort_order`,
  );
  return rows.map(decryptDepartment);
}

function buildDepartmentMap(departments: OrgDepartment[]): Map<string, OrgDepartment> {
  return new Map(departments.map(department => [department.id, department]));
}

function collectDescendantIds(
  rootId: string,
  childrenByParent: Map<string | null, OrgDepartment[]>,
): Set<string> {
  const ids = new Set<string>();
  const stack = [rootId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ids.has(current)) continue;
    ids.add(current);

    for (const child of childrenByParent.get(current) || []) {
      stack.push(child.id);
    }
  }

  return ids;
}

function buildChildrenMap(departments: OrgDepartment[]): Map<string | null, OrgDepartment[]> {
  const map = new Map<string | null, OrgDepartment[]>();
  for (const department of departments) {
    const bucket = map.get(department.parent_id) || [];
    bucket.push(department);
    map.set(department.parent_id, bucket);
  }
  return map;
}

function collapseSelectedDepartments(
  selectedIds: string[],
  departmentMap: Map<string, OrgDepartment>,
): string[] {
  const selected = new Set(selectedIds);
  return selectedIds.filter(departmentId => {
    let currentParent = departmentMap.get(departmentId)?.parent_id || null;
    while (currentParent) {
      if (selected.has(currentParent)) {
        return false;
      }
      currentParent = departmentMap.get(currentParent)?.parent_id || null;
    }
    return true;
  });
}

async function ensureDepartmentIsMutable(departmentId: string): Promise<void> {
  if (await isProtectedArchiveDepartment(departmentId)) {
    throw createHttpError(409, 'Системную папку "Уволенные" нельзя изменять или удалять');
  }
}

async function ensureParentIsAllowed(parentId: string | null): Promise<void> {
  if (!parentId) return;
  if (await isProtectedArchiveDepartment(parentId)) {
    throw createHttpError(409, 'Нельзя вкладывать отделы в системную папку "Уволенные"');
  }
}

async function ensureDepartmentIsEmpty(departmentId: string, allDepartments: OrgDepartment[]): Promise<void> {
  if (allDepartments.some(department => department.parent_id === departmentId)) {
    throw createHttpError(409, 'Отдел содержит вложенные отделы. Используйте рекурсивное удаление.');
  }

  const row = await queryOne<{ cnt: string }>(
    'SELECT count(*)::text AS cnt FROM employees WHERE org_department_id = $1',
    [departmentId],
  );
  const count = Number(row?.cnt ?? 0);

  if (count > 0) {
    throw createHttpError(409, 'Отдел не пуст. Сначала переместите сотрудников или используйте рекурсивное удаление.');
  }
}

function validateParentMove(
  departmentId: string,
  parentId: string | null,
  childrenByParent: Map<string | null, OrgDepartment[]>,
): void {
  if (!parentId) return;
  if (parentId === departmentId) {
    throw createHttpError(400, 'Нельзя сделать отдел родителем самого себя');
  }

  const descendants = collectDescendantIds(departmentId, childrenByParent);
  if (descendants.has(parentId)) {
    throw createHttpError(400, 'Нельзя переместить отдел в самого себя или своего потомка');
  }
}

/**
 * Загружает scope доступных department id'ов как Set | 'all'.
 * Используется CRUD-эндпоинтами structure.controller для валидации target_node.
 */
async function loadAccessibleDeptSet(req: AuthenticatedRequest): Promise<Set<string> | 'all'> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  return accessible === 'all' ? 'all' : new Set(accessible);
}

function assertInScope(scope: Set<string> | 'all', departmentId: string | null): void {
  if (scope === 'all') return;
  if (!departmentId) {
    throw createHttpError(403, 'Создание корневых компаний доступно только системному администратору');
  }
  if (!scope.has(departmentId)) {
    throw createHttpError(403, 'Отдел вне вашей зоны доступа');
  }
}

/**
 * Фильтрует дерево по scope. Нода остаётся в дереве, если её id в scope
 * ИЛИ если в её поддереве есть нода из scope (чтобы сохранить иерархический
 * путь от корня к назначенному отделу).
 *
 * Корневой синтетический «Объект» (parent_id=null) всегда сохраняется
 * как контейнер, но его дети-компании фильтруются.
 *
 * scope='all' — возвращаем дерево как есть.
 */
function filterTreeByScope(tree: OrgDepartmentNode[], scope: Set<string> | 'all'): OrgDepartmentNode[] {
  if (scope === 'all') return tree;

  const filterRecursive = (nodes: OrgDepartmentNode[]): OrgDepartmentNode[] =>
    nodes.reduce<OrgDepartmentNode[]>((acc, node) => {
      const children = filterRecursive(node.children);
      if (scope.has(node.id) || children.length > 0) {
        acc.push({ ...node, children });
      }
      return acc;
    }, []);

  return tree.map(node => {
    if (node.parent_id === null) {
      return { ...node, children: filterRecursive(node.children) };
    }
    return node;
  });
}

function getStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = 'status' in error ? Number(error.status) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function getMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Загрузка тела ответа /api/structure без res. Используется как:
 * 1) основной путь в getTree;
 * 2) refresh-функция для SWR-кеша structureTreeCache (отдаёт stale, в фоне обновляет).
 */
async function loadTreeForCache(req: AuthenticatedRequest): Promise<object> {
  const [departments, archiveDepartment, scope] = await Promise.all([
    loadAllActiveDepartments(),
    getKnownArchiveDepartment(),
    loadAccessibleDeptSet(req),
  ]);
  const fullTree = buildDepartmentTree(departments, null);
  const departmentTree = filterTreeByScope(fullTree, scope);

  return {
    success: true,
    data: {
      departments: departmentTree,
      stats: {
        departments: departments.length,
        archive_department_id: archiveDepartment?.id || null,
      },
    },
  };
}

export const structureController = {
  loadTreeForCache,

  async getTree(req: AuthenticatedRequest, res: Response): Promise<void> {
    const tStart = Date.now();
    try {
      const body = await loadTreeForCache(req);
      const totalMs = Date.now() - tStart;
      if (totalMs > 2000) {
        Sentry.captureMessage('slow_endpoint', {
          level: 'warning',
          tags: { endpoint: 'structure' },
          extra: { totalMs },
        });
      }
      res.setHeader('Cache-Control', 'private, max-age=120');
      res.setHeader('Server-Timing', `structure_load;dur=${totalMs}`);
      res.json(body);
    } catch (error) {
      console.error('Get structure error:', error);
      Sentry.captureException(error, {
        tags: { route: 'GET /api/structure/tree' },
        extra: {
          userId: req.user?.id,
          isAdmin: req.user?.is_admin,
          companyScopeRoots: Array.isArray(req.user?.company_scope?.roots)
            ? req.user.company_scope.roots
            : req.user?.company_scope?.roots ?? null,
        },
      });
      res.status(500).json({ success: false, error: 'Ошибка получения структуры' });
    }
  },

  async createDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const description = typeof req.body.description === 'string' ? req.body.description.trim() : null;
      const parentId = typeof req.body.parent_id === 'string' && req.body.parent_id.trim()
        ? req.body.parent_id.trim()
        : null;

      if (!name) {
        res.status(400).json({ success: false, error: 'Название обязательно' });
        return;
      }

      if (parentId) {
        const parent = await queryOne<{ id: string }>(
          'SELECT id FROM org_departments WHERE id = $1 AND is_active = true',
          [parentId],
        );

        if (!parent) {
          res.status(400).json({ success: false, error: 'Родительский отдел не найден' });
          return;
        }
      }

      const scope = await loadAccessibleDeptSet(req);
      assertInScope(scope, parentId);

      await ensureParentIsAllowed(parentId);

      const explicitKind = parseKind(req.body.kind);
      const kind: OrgDepartmentKind = explicitKind
        ?? detectDepartmentKindFromName(name, { isRoot: parentId === null });

      let data: OrgDepartmentEncrypted | null = null;
      try {
        data = await queryOne<OrgDepartmentEncrypted>(
          `INSERT INTO org_departments (parent_id, name, description, kind)
           VALUES ($1, $2, $3, $4)
           RETURNING id, parent_id, sigur_department_id, name, description, sort_order,
                     is_active, kind, created_at, updated_at`,
          [parentId, name, description, kind],
        );
      } catch (createErr) {
        console.error('Create department error:', createErr);
        res.status(500).json({ success: false, error: 'Ошибка создания отдела' });
        return;
      }
      if (!data) {
        res.status(500).json({ success: false, error: 'Ошибка создания отдела' });
        return;
      }

      invalidateDeptTreeCache();
      await auditService.logFromRequest(req, req.user.id, 'CREATE_ORG_DEPARTMENT', {
        entityType: 'org_department',
        entityId: data.id,
      });

      res.status(201).json({ success: true, data: decryptDepartment(data as OrgDepartmentEncrypted) });
    } catch (error) {
      const status = getStatus(error);
      if (status) {
        res.status(status).json({ success: false, error: getMessage(error, 'Ошибка создания отдела') });
        return;
      }

      console.error('Create department error:', error);
      res.status(500).json({ success: false, error: 'Ошибка создания отдела' });
    }
  },

  async updateDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name');
      const hasParent = Object.prototype.hasOwnProperty.call(req.body, 'parent_id');
      const hasKind = Object.prototype.hasOwnProperty.call(req.body, 'kind');

      if (!hasName && !hasParent && !hasKind) {
        res.status(400).json({ success: false, error: 'Нет данных для обновления отдела' });
        return;
      }

      const departments = await loadAllActiveDepartments();
      const departmentMap = buildDepartmentMap(departments);
      const childrenByParent = buildChildrenMap(departments);
      const current = departmentMap.get(id);

      if (!current) {
        res.status(404).json({ success: false, error: 'Отдел не найден' });
        return;
      }

      const scope = await loadAccessibleDeptSet(req);
      assertInScope(scope, id);

      await ensureDepartmentIsMutable(id);

      const name = hasName ? String(req.body.name || '').trim() : current.name;
      const parentId = hasParent
        ? (typeof req.body.parent_id === 'string' && req.body.parent_id.trim() ? req.body.parent_id.trim() : null)
        : current.parent_id;

      let kind: OrgDepartmentKind = current.kind;
      if (hasKind) {
        const parsed = parseKind(req.body.kind);
        if (!parsed) {
          res.status(400).json({ success: false, error: 'Недопустимое значение поля kind' });
          return;
        }
        kind = parsed;
      }

      if (!name) {
        res.status(400).json({ success: false, error: 'Название обязательно' });
        return;
      }

      if (parentId && !departmentMap.has(parentId)) {
        res.status(400).json({ success: false, error: 'Родительский отдел не найден' });
        return;
      }

      // Перенос между разными «компаниями» запрещён для company-admin
      if (parentId !== current.parent_id) {
        assertInScope(scope, parentId);
      }

      await ensureParentIsAllowed(parentId);
      validateParentMove(id, parentId, childrenByParent);

      const updateData: Record<string, unknown> = {};
      if (name !== current.name) updateData.name = name;
      if (parentId !== current.parent_id) updateData.parent_id = parentId;
      if (kind !== current.kind) updateData.kind = kind;

      if (Object.keys(updateData).length === 0) {
        res.json({ success: true, data: current });
        return;
      }

      const setKeys = Object.keys(updateData);
      const params: unknown[] = setKeys.map(k => updateData[k]);
      const setSql = setKeys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      params.push(id);
      let data: OrgDepartmentEncrypted | null = null;
      try {
        data = await queryOne<OrgDepartmentEncrypted>(
          `UPDATE org_departments SET ${setSql}
            WHERE id = $${params.length}
            RETURNING id, parent_id, sigur_department_id, name, description, sort_order,
                      is_active, kind, created_at, updated_at`,
          params,
        );
      } catch (updErr) {
        console.error('Update department error:', updErr);
        res.status(500).json({ success: false, error: 'Ошибка обновления отдела' });
        return;
      }
      if (!data) {
        res.status(500).json({ success: false, error: 'Ошибка обновления отдела' });
        return;
      }

      invalidateDeptTreeCache();
      await auditService.logFromRequest(req, req.user.id, 'UPDATE_ORG_DEPARTMENT', {
        entityType: 'org_department',
        entityId: id,
        details: updateData,
      });

      res.json({ success: true, data: decryptDepartment(data) });
    } catch (error) {
      const status = getStatus(error);
      if (status) {
        res.status(status).json({ success: false, error: getMessage(error, 'Ошибка обновления отдела') });
        return;
      }

      console.error('Update department error:', error);
      res.status(500).json({ success: false, error: 'Ошибка обновления отдела' });
    }
  },

  async batchMoveDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parentId = typeof req.body.parent_id === 'string' && req.body.parent_id.trim()
        ? req.body.parent_id.trim()
        : null;
      const rawDepartmentIds = Array.isArray(req.body.department_ids) ? req.body.department_ids : [];
      const selectedIds: string[] = Array.from(
        new Set(
          rawDepartmentIds.filter(
            (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0,
          ),
        ),
      );

      if (selectedIds.length === 0) {
        res.status(400).json({ success: false, error: 'department_ids required' });
        return;
      }

      const departments = await loadAllActiveDepartments();
      const departmentMap = buildDepartmentMap(departments);
      const childrenByParent = buildChildrenMap(departments);

      if (parentId && !departmentMap.has(parentId)) {
        res.status(400).json({ success: false, error: 'Родительский отдел не найден' });
        return;
      }

      const scope = await loadAccessibleDeptSet(req);
      assertInScope(scope, parentId);

      await ensureParentIsAllowed(parentId);

      const normalizedIds = selectedIds.filter(id => departmentMap.has(id));
      if (normalizedIds.length === 0) {
        res.status(404).json({ success: false, error: 'Отделы не найдены' });
        return;
      }

      const topLevelIds = collapseSelectedDepartments(normalizedIds, departmentMap);
      for (const departmentId of topLevelIds) {
        assertInScope(scope, departmentId);
        await ensureDepartmentIsMutable(departmentId);
        validateParentMove(departmentId, parentId, childrenByParent);
      }

      const movedIds: string[] = [];
      const skippedIds: string[] = [];

      for (const departmentId of topLevelIds) {
        const current = departmentMap.get(departmentId)!;
        if (current.parent_id === parentId) {
          skippedIds.push(departmentId);
          continue;
        }

        await execute(
          'UPDATE org_departments SET parent_id = $1 WHERE id = $2',
          [parentId, departmentId],
        );

        movedIds.push(departmentId);
      }

      invalidateDeptTreeCache();
      await auditService.logFromRequest(req, req.user.id, 'MOVE_ORG_DEPARTMENT_BATCH', {
        details: {
          parent_id: parentId,
          moved_ids: movedIds,
          skipped_ids: skippedIds,
        },
      });

      res.json({
        success: true,
        data: {
          parent_id: parentId,
          moved_count: movedIds.length,
          skipped_count: skippedIds.length,
          moved_ids: movedIds,
          skipped_ids: skippedIds,
        },
      });
    } catch (error) {
      const status = getStatus(error);
      if (status) {
        res.status(status).json({ success: false, error: getMessage(error, 'Ошибка перемещения отделов') });
        return;
      }

      console.error('Batch move departments error:', error);
      res.status(500).json({ success: false, error: 'Ошибка перемещения отделов' });
    }
  },

  async deleteDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const departments = await loadAllActiveDepartments();
      const current = departments.find(department => department.id === id) || null;

      if (!current) {
        res.status(404).json({ success: false, error: 'Отдел не найден' });
        return;
      }

      const scope = await loadAccessibleDeptSet(req);
      assertInScope(scope, id);

      await ensureDepartmentIsMutable(id);
      await ensureDepartmentIsEmpty(id, departments);

      try {
        await execute('DELETE FROM org_departments WHERE id = $1', [id]);
      } catch (deleteErr) {
        console.error('Delete department error:', deleteErr);
        res.status(500).json({ success: false, error: 'Ошибка удаления отдела' });
        return;
      }

      invalidateDeptTreeCache();
      await auditService.logFromRequest(req, req.user.id, 'DELETE_ORG_DEPARTMENT', {
        entityType: 'org_department',
        entityId: id,
      });

      res.json({ success: true, message: 'Отдел удалён' });
    } catch (error) {
      const status = getStatus(error);
      if (status) {
        res.status(status).json({ success: false, error: getMessage(error, 'Ошибка удаления отдела') });
        return;
      }

      console.error('Delete department error:', error);
      res.status(500).json({ success: false, error: 'Ошибка удаления отдела' });
    }
  },

  async deleteDepartmentRecursive(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const departments = await loadAllActiveDepartments();
      const departmentMap = buildDepartmentMap(departments);
      const childrenByParent = buildChildrenMap(departments);
      const root = departmentMap.get(id);

      if (!root) {
        res.status(404).json({ success: false, error: 'Отдел не найден' });
        return;
      }

      const scope = await loadAccessibleDeptSet(req);
      assertInScope(scope, id);

      await ensureDepartmentIsMutable(id);

      const subtreeIds = collectDescendantIds(id, childrenByParent);
      for (const departmentId of subtreeIds) {
        if (departmentId !== id && (await isProtectedArchiveDepartment(departmentId))) {
          throw createHttpError(409, 'Нельзя удалить ветку, содержащую системную папку "Уволенные"');
        }
      }

      const subtreeList = [...subtreeIds];
      const targetParentId = root.parent_id;
      const timestamp = new Date().toISOString();

      const depthOf = (departmentId: string): number => {
        let depth = 0;
        let current = departmentMap.get(departmentId) || null;
        while (current?.parent_id) {
          depth += 1;
          current = departmentMap.get(current.parent_id) || null;
        }
        return depth;
      };

      const orderedIds = subtreeList.sort((left, right) => depthOf(right) - depthOf(left));

      await withTransaction(async (client) => {
        await client.query(
          `UPDATE employees
              SET org_department_id = $1, updated_at = $2
            WHERE org_department_id = ANY($3::uuid[])`,
          [targetParentId, timestamp, subtreeList],
        );

        await client.query(
          `UPDATE employee_assignments
              SET org_department_id = $1, updated_at = $2
            WHERE org_department_id = ANY($3::uuid[])`,
          [targetParentId, timestamp, subtreeList],
        );

        for (const departmentId of orderedIds) {
          await client.query(
            'DELETE FROM org_departments WHERE id = $1',
            [departmentId],
          );
        }
      });

      invalidateDeptTreeCache();
      await auditService.logFromRequest(req, req.user.id, 'DELETE_ORG_DEPARTMENT_RECURSIVE', {
        entityType: 'org_department',
        entityId: id,
        details: {
          target_parent_id: targetParentId,
          deleted_department_ids: orderedIds,
        },
      });

      res.json({
        success: true,
        data: {
          deleted_count: orderedIds.length,
          deleted_department_ids: orderedIds,
          target_parent_id: targetParentId,
        },
      });
    } catch (error) {
      const status = getStatus(error);
      if (status) {
        res.status(status).json({ success: false, error: getMessage(error, 'Ошибка рекурсивного удаления отдела') });
        return;
      }

      console.error('Delete department recursive error:', error);
      res.status(500).json({ success: false, error: 'Ошибка рекурсивного удаления отдела' });
    }
  },

  async clearStructure(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const companyScope = await resolveCompanyScope(req);
      if (companyScope.roots !== 'all') {
        res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
        return;
      }

      let employeesDeleted = 0;
      try {
        employeesDeleted = await execute(
          'DELETE FROM employees WHERE id <> 0',
        );
      } catch (empError) {
        console.error('Clear employees error:', empError);
        res.status(500).json({ success: false, error: 'Ошибка удаления сотрудников' });
        return;
      }

      let departmentsDeleted = 0;
      try {
        departmentsDeleted = await execute(
          `DELETE FROM org_departments WHERE id <> '00000000-0000-0000-0000-000000000000'::uuid`,
        );
      } catch (deptError) {
        console.error('Clear departments error:', deptError);
        res.status(500).json({ success: false, error: 'Ошибка удаления отделов' });
        return;
      }

      invalidateDeptTreeCache();
      await auditService.logFromRequest(req, req.user.id, 'CLEAR_STRUCTURE', {
        details: { employeesDeleted, departmentsDeleted },
      });

      res.json({
        success: true,
        data: {
          employeesDeleted: employeesDeleted || 0,
          departmentsDeleted: departmentsDeleted || 0,
        },
      });
    } catch (error) {
      console.error('Clear structure error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки структуры' });
    }
  },

  async findOrCreateDepartment(name: string, parentId: string | null): Promise<string | null> {
    if (!name || !name.trim()) return null;

    const trimmedName = name.trim();

    const params: unknown[] = [];
    let sql = 'SELECT id, name FROM org_departments WHERE is_active = true';
    if (parentId) {
      params.push(parentId);
      sql += ` AND parent_id = $${params.length}`;
    } else {
      sql += ' AND parent_id IS NULL';
    }

    const existing = await query<{ id: string; name: string | null }>(sql, params);
    const found = existing.find(department => (
      (department.name || '').toLowerCase() === trimmedName.toLowerCase()
    ));

    if (found) {
      return found.id;
    }

    try {
      const created = await queryOne<{ id: string }>(
        `INSERT INTO org_departments (parent_id, name) VALUES ($1, $2) RETURNING id`,
        [parentId, trimmedName],
      );
      return created?.id ?? null;
    } catch (err) {
      console.error('Auto-create department error:', err);
      return null;
    }
  },

  async getPositions(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const rows = await query<{ id: string; name: string }>(
        `SELECT id, name FROM positions WHERE is_active = true ORDER BY name`,
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Get positions error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch positions' });
    }
  },
};
