import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Дерево фильтра отделов в «Управлении кадрами»: с правом «Управление кадрами — все
 * сотрудники» — все активные отделы; без права — ровно то же, что общий /api/structure
 * (бригады табельщицы). Общее дерево правом не расширяется.
 */

const h = vi.hoisted(() => ({
  grant: false,
  accessible: [] as string[] | 'all',
}));

const DEPARTMENTS = [
  { id: 'root', parent_id: null, name: 'Объект', description: null, sort_order: 0, is_active: true, is_assignable: true, kind: null, sigur_department_id: null, created_at: '', updated_at: '' },
  { id: 'own', parent_id: 'root', name: 'бр.Менгбоев Г.И.', description: null, sort_order: 1, is_active: true, is_assignable: true, kind: 'brigade', sigur_department_id: null, created_at: '', updated_at: '' },
  { id: 'foreign', parent_id: 'root', name: 'Отдел цифровой трансформации', description: null, sort_order: 2, is_active: true, is_assignable: true, kind: null, sigur_department_id: null, created_at: '', updated_at: '' },
];

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => DEPARTMENTS),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { logFromRequest: vi.fn() } }));
vi.mock('../services/employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: vi.fn(async () => ({ id: 'archive' })),
  isProtectedArchiveDepartment: vi.fn(async () => false),
}));
vi.mock('../services/skud-shared.service.js', () => ({ invalidateDeptTreeCache: vi.fn() }));
vi.mock('../services/data-scope.service.js', () => ({
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  resolveAccessibleDepartmentIds: vi.fn(async () => h.accessible),
  resolveCompanyScope: vi.fn(async () => ({ roots: [] })),
}));
vi.mock('../services/timekeeper-scope.service.js', () => ({
  isTimekeeper: vi.fn(() => true),
  LI_OBSHESTROY_DEPARTMENT_ID: 'li',
}));
vi.mock('../services/read-scope-grants.service.js', () => ({
  hasDashboardAllDepartmentsGrant: vi.fn(async () => false),
  hasStaffAllEmployeesGrant: vi.fn(async () => h.grant),
}));
vi.mock('../services/payroll/payroll-access.service.js', () => ({
  getRequestPayrollSectionAccess: vi.fn(async () => false),
}));

import { structureController } from './structure.controller.js';

const req = { user: { id: 'tk-1', role_code: 'timekeeper', is_admin: false } } as unknown as AuthenticatedRequest;

type TreeNode = { id: string; children: TreeNode[] };
type TreeBody = { success: boolean; data: { departments: TreeNode[]; stats: { archive_department_id: string | null } } };
const ids = (nodes: TreeNode[]): string[] => nodes.flatMap(node => [node.id, ...ids(node.children)]);
const treeIds = (body: object): string[] => ids((body as TreeBody).data.departments).sort();

const callStaffTree = async (): Promise<{ statusCode: number; body: TreeBody }> => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  await structureController.getStaffTree(req, res as unknown as Response);
  return res as { statusCode: number; body: TreeBody };
};

beforeEach(() => {
  h.grant = false;
  h.accessible = ['own'];
});

describe('structureController.getStaffTree', () => {
  it('с правом — все активные отделы и id папки «Уволенные»', async () => {
    h.grant = true;
    const res = await callStaffTree();
    expect(res.statusCode).toBe(200);
    expect(treeIds(res.body)).toEqual(['foreign', 'own', 'root']);
    expect(res.body.data.stats.archive_department_id).toBe('archive');
  });

  it('без права — совпадает с общим деревом роли', async () => {
    const res = await callStaffTree();
    const common = await structureController.loadTreeForCache(req);
    expect(treeIds(res.body)).toEqual(treeIds(common));
    expect(treeIds(res.body)).not.toContain('foreign');
  });

  it('право не расширяет общее дерево /api/structure', async () => {
    h.grant = true;
    expect(treeIds(await structureController.loadTreeForCache(req))).not.toContain('foreign');
  });
});
