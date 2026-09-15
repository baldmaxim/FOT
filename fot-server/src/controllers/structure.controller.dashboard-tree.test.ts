import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Дерево селектора «Обзора»: с правом «Обзор — все отделы» — все активные отделы;
 * без права — ровно то же, что общий /api/structure (скоуп роли). Общее дерево
 * правом не расширяется.
 */

const h = vi.hoisted(() => ({
  grant: false,
  accessible: [] as string[] | 'all',
}));

const DEPARTMENTS = [
  { id: 'root', parent_id: null, name: 'Объект', description: null, sort_order: 0, is_active: true, is_assignable: true, kind: null, sigur_department_id: null, created_at: '', updated_at: '' },
  { id: 'own', parent_id: 'root', name: 'Отдел организационного обеспечения', description: null, sort_order: 1, is_active: true, is_assignable: true, kind: null, sigur_department_id: null, created_at: '', updated_at: '' },
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
  getKnownArchiveDepartment: vi.fn(async () => null),
  isProtectedArchiveDepartment: vi.fn(async () => false),
}));
vi.mock('../services/skud-shared.service.js', () => ({ invalidateDeptTreeCache: vi.fn() }));
vi.mock('../services/data-scope.service.js', () => ({
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  resolveAccessibleDepartmentIds: vi.fn(async () => h.accessible),
  resolveCompanyScope: vi.fn(async () => ({ roots: [] })),
}));
vi.mock('../services/timekeeper-scope.service.js', () => ({
  isTimekeeper: vi.fn(() => false),
  LI_OBSHESTROY_DEPARTMENT_ID: 'li',
}));
vi.mock('../services/read-scope-grants.service.js', () => ({
  hasDashboardAllDepartmentsGrant: vi.fn(async () => h.grant),
}));

import { structureController } from './structure.controller.js';

const req = { user: { id: 'u-1', role_code: 'security', is_admin: false } } as unknown as AuthenticatedRequest;

type TreeNode = { id: string; children: TreeNode[] };
const ids = (nodes: TreeNode[]): string[] => nodes.flatMap(node => [node.id, ...ids(node.children)]);
const treeIds = (body: object): string[] =>
  ids((body as { data: { departments: TreeNode[] } }).data.departments).sort();

beforeEach(() => {
  h.grant = false;
  h.accessible = ['own'];
});

describe('structureController.loadDashboardTreeForCache', () => {
  it('с правом — все активные отделы', async () => {
    h.grant = true;
    expect(treeIds(await structureController.loadDashboardTreeForCache(req))).toEqual(['foreign', 'own', 'root']);
  });

  it('без права — совпадает с общим деревом роли', async () => {
    const dashboard = await structureController.loadDashboardTreeForCache(req);
    const common = await structureController.loadTreeForCache(req);
    expect(treeIds(dashboard)).toEqual(treeIds(common));
    expect(treeIds(dashboard)).not.toContain('foreign');
  });

  it('право не расширяет общее дерево /api/structure', async () => {
    h.grant = true;
    expect(treeIds(await structureController.loadTreeForCache(req))).not.toContain('foreign');
  });
});
