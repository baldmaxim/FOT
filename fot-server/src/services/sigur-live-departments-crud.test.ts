import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * CRUD отделов Sigur: обновление зеркала ФОТ запускается из сервиса сразу после
 * записи в Sigur (падение readback/аудита не должно его отменять), а гасим в
 * зеркале только реально удалённые отделы.
 */

const h = vi.hoisted(() => ({
  createDepartment: vi.fn(),
  updateDepartment: vi.fn(),
  deleteDepartment: vi.fn(),
  getDepartmentById: vi.fn(),
  getEmployeesPage: vi.fn(),
  invalidateDepartmentCache: vi.fn(),
  invalidateEmployeeCache: vi.fn(),
  updateEmployee: vi.fn(),
  getNormalizedDepartments: vi.fn(),
  collectDescendants: vi.fn(),
  collectAncestors: vi.fn(),
  requestRefresh: vi.fn(),
  deactivate: vi.fn(),
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: {
    createDepartment: h.createDepartment,
    updateDepartment: h.updateDepartment,
    deleteDepartment: h.deleteDepartment,
    getDepartmentById: h.getDepartmentById,
    getEmployeesPage: h.getEmployeesPage,
    updateEmployee: h.updateEmployee,
    invalidateDepartmentCache: h.invalidateDepartmentCache,
    invalidateEmployeeCache: h.invalidateEmployeeCache,
  },
}));
vi.mock('./sigur-live-admin.service.js', () => ({
  getNormalizedDepartments: h.getNormalizedDepartments,
  collectSigurDepartmentDescendantIds: h.collectDescendants,
  collectAncestorDepartmentIds: h.collectAncestors,
  collapseNestedDepartmentSelection: (ids: number[]) => ids,
  normalizeDepartmentIds: (ids: number[]) => ids,
  normalizeInt: (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : null),
  invalidateSigurDirectoryCaches: vi.fn(),
}));
vi.mock('./sigur-structure-refresh.service.js', () => ({
  requestDepartmentsMirrorRefresh: h.requestRefresh,
  deactivateMirroredDepartments: h.deactivate,
}));

import {
  createSigurDepartment,
  deleteSigurDepartmentRecursive,
  updateSigurDepartment,
} from './sigur-live-departments-crud.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.getEmployeesPage.mockResolvedValue([]);
  h.deactivate.mockResolvedValue(0);
  h.collectAncestors.mockReturnValue(new Set());
});

describe('createSigurDepartment / updateSigurDepartment', () => {
  it('запрашивает refresh зеркала даже если readback из Sigur упал', async () => {
    h.createDepartment.mockResolvedValue({ id: 150749 });
    h.getDepartmentById.mockRejectedValue(new Error('Sigur 500'));

    await expect(createSigurDepartment({ name: 'Отдел экономики строительства', parentId: 142365 }, 'internal'))
      .rejects.toThrow('Sigur 500');

    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
    expect(h.requestRefresh).toHaveBeenCalledWith('admin_crud', 'internal');
  });

  it('переименование: refresh запрошен до readback', async () => {
    h.updateDepartment.mockResolvedValue(undefined);
    h.getDepartmentById.mockRejectedValue(new Error('Sigur timeout'));

    await expect(updateSigurDepartment(150749, { name: 'Новое имя' })).rejects.toThrow('Sigur timeout');

    expect(h.requestRefresh).toHaveBeenCalledWith('admin_crud', undefined);
  });
});

describe('deleteSigurDepartmentRecursive', () => {
  it('частичный сбой: гасит в зеркале только реально удалённые отделы', async () => {
    h.getNormalizedDepartments.mockResolvedValue([
      { id: 1, name: 'Корень ветки', parentId: 100 },
      { id: 2, name: 'Дочерний A', parentId: 1 },
      { id: 3, name: 'Дочерний B', parentId: 1 },
    ]);
    h.collectDescendants.mockReturnValue(new Set([1, 2, 3]));
    h.deleteDepartment.mockImplementation(async (id: number) => {
      if (id === 2) throw new Error('Sigur: отдел занят');
    });

    const result = await deleteSigurDepartmentRecursive(1);

    expect(result.deletedIds.sort()).toEqual([1, 3]);
    expect(result.deleted).toBe(2);
    expect(h.deactivate).toHaveBeenCalledTimes(1);
    expect((h.deactivate.mock.calls[0][0] as number[]).slice().sort()).toEqual([1, 3]);
    expect(h.requestRefresh).toHaveBeenCalledWith('admin_crud', undefined);
  });
});
