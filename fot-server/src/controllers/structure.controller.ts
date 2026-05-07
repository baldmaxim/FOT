import { Response } from 'express';
import { supabase } from '../config/database.js';
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
  return allDepts
    .filter(department => department.parent_id === parentId)
    .sort((left, right) => left.sort_order - right.sort_order)
    .map(department => ({
      ...department,
      children: buildDepartmentTree(allDepts, department.id),
    }));
}

async function loadAllActiveDepartments(): Promise<OrgDepartment[]> {
  const { data, error } = await supabase
    .from('org_departments')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');

  if (error) {
    throw error;
  }

  return ((data || []) as OrgDepartmentEncrypted[]).map(decryptDepartment);
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

  const { count, error } = await supabase
    .from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('org_department_id', departmentId);

  if (error) {
    throw error;
  }

  if ((count || 0) > 0) {
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
 * Фильтрует дерево по company-scope. Возвращает корневой синтетический «Объект»
 * только с детьми, входящими в scope. Если scope='all', возвращает дерево как есть.
 */
function filterTreeByScope(tree: OrgDepartmentNode[], scope: Set<string> | 'all'): OrgDepartmentNode[] {
  if (scope === 'all') return tree;
  return tree.map(node => {
    if (node.parent_id === null) {
      // Корневой узел («Объект»): сохраняем, но фильтруем детей по scope
      return {
        ...node,
        children: node.children.filter(child => scope.has(child.id)),
      };
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

export const structureController = {
  async getTree(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const [departments, archiveDepartment, scope] = await Promise.all([
        loadAllActiveDepartments(),
        getKnownArchiveDepartment(),
        loadAccessibleDeptSet(req),
      ]);
      const fullTree = buildDepartmentTree(departments, null);
      const departmentTree = filterTreeByScope(fullTree, scope);

      res.setHeader('Cache-Control', 'private, max-age=120');
      res.json({
        success: true,
        data: {
          departments: departmentTree,
          stats: {
            departments: departments.length,
            archive_department_id: archiveDepartment?.id || null,
          },
        },
      });
    } catch (error) {
      console.error('Get structure error:', error);
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
        const parent = await supabase
          .from('org_departments')
          .select('id')
          .eq('id', parentId)
          .eq('is_active', true)
          .maybeSingle();

        if (!parent.data) {
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

      const { data, error } = await supabase
        .from('org_departments')
        .insert({
          parent_id: parentId,
          name,
          description,
          kind,
        })
        .select()
        .single();

      if (error || !data) {
        console.error('Create department error:', error);
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

      const { data, error } = await supabase
        .from('org_departments')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (error || !data) {
        console.error('Update department error:', error);
        res.status(500).json({ success: false, error: 'Ошибка обновления отдела' });
        return;
      }

      invalidateDeptTreeCache();
      await auditService.logFromRequest(req, req.user.id, 'UPDATE_ORG_DEPARTMENT', {
        entityType: 'org_department',
        entityId: id,
        details: updateData,
      });

      res.json({ success: true, data: decryptDepartment(data as OrgDepartmentEncrypted) });
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

        const { error } = await supabase
          .from('org_departments')
          .update({ parent_id: parentId })
          .eq('id', departmentId);

        if (error) {
          throw error;
        }

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

      const { error } = await supabase
        .from('org_departments')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('Delete department error:', error);
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

      const { error: employeesError } = await supabase
        .from('employees')
        .update({
          org_department_id: targetParentId,
          updated_at: timestamp,
        })
        .in('org_department_id', subtreeList);

      if (employeesError) {
        throw employeesError;
      }

      const { error: assignmentsError } = await supabase
        .from('employee_assignments')
        .update({
          org_department_id: targetParentId,
          updated_at: timestamp,
        })
        .in('org_department_id', subtreeList);

      if (assignmentsError) {
        throw assignmentsError;
      }

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
      for (const departmentId of orderedIds) {
        const { error } = await supabase
          .from('org_departments')
          .delete()
          .eq('id', departmentId);

        if (error) {
          throw error;
        }
      }

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

      const { count: employeesDeleted, error: empError } = await supabase
        .from('employees')
        .delete({ count: 'exact' })
        .neq('id', 0);

      if (empError) {
        console.error('Clear employees error:', empError);
        res.status(500).json({ success: false, error: 'Ошибка удаления сотрудников' });
        return;
      }

      const { count: departmentsDeleted, error: deptError } = await supabase
        .from('org_departments')
        .delete({ count: 'exact' })
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (deptError) {
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

    let query = supabase
      .from('org_departments')
      .select('id, name')
      .eq('is_active', true);

    if (parentId) {
      query = query.eq('parent_id', parentId);
    } else {
      query = query.is('parent_id', null);
    }

    const { data: existing } = await query;
    const found = (existing || []).find((department: { name: string }) => (
      (department.name || '').toLowerCase() === trimmedName.toLowerCase()
    ));

    if (found) {
      return found.id;
    }

    const { data: created, error } = await supabase
      .from('org_departments')
      .insert({
        parent_id: parentId,
        name: trimmedName,
      })
      .select()
      .single();

    if (error) {
      console.error('Auto-create department error:', error);
      return null;
    }

    return created.id;
  },

  async getPositions(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('positions')
        .select('id, name')
        .eq('is_active', true)
        .order('name');

      if (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch positions' });
        return;
      }

      res.json({ success: true, data: data || [] });
    } catch (error) {
      console.error('Get positions error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch positions' });
    }
  },
};
