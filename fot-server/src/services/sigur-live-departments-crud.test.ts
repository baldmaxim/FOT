import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * CRUD отделов Sigur: ответ отдаётся только после подтверждённого зеркала —
 * иначе сразу после «отдел создан» в него нельзя добавить сотрудника (в
 * org_departments строки ещё нет), и это выглядит как «получилось со второй
 * попытки». Гасим в зеркале только реально удалённые отделы.
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
  refreshNow: vi.fn(),
  deactivate: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ queryOne: h.queryOne }));

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
  runDepartmentsMirrorRefreshNow: h.refreshNow,
  deactivateMirroredDepartments: h.deactivate,
}));

import {
  createSigurDepartment,
  deleteSigurDepartmentRecursive,
  updateSigurDepartment,
} from './sigur-live-departments-crud.service.js';

const MIRRORED_ROW = { id: 'dept-uuid', is_active: true, is_assignable: true };

beforeEach(() => {
  vi.clearAllMocks();
  h.getEmployeesPage.mockResolvedValue([]);
  h.deactivate.mockResolvedValue(0);
  h.collectAncestors.mockReturnValue(new Set());
  h.refreshNow.mockResolvedValue({ ok: true });
  h.queryOne.mockResolvedValue(MIRRORED_ROW);
});

describe('createSigurDepartment / updateSigurDepartment', () => {
  it('дожидается зеркала и отдаёт mirrorReady=true', async () => {
    h.createDepartment.mockResolvedValue({ id: 150749 });
    h.getDepartmentById.mockResolvedValue({ id: 150749, name: 'Отдел экономики строительства', parentId: 142365 });

    const created = await createSigurDepartment(
      { name: 'Отдел экономики строительства', parentId: 142365 },
      'internal',
    );

    expect(h.refreshNow).toHaveBeenCalledWith('admin_crud', 'internal');
    expect(created).toMatchObject({ id: 150749, mirrorReady: true });
  });

  it('зеркало не сошлось → mirrorReady=false, ошибку не бросаем (в Sigur отдел уже есть)', async () => {
    h.createDepartment.mockResolvedValue({ id: 150749 });
    h.refreshNow.mockResolvedValue({ ok: false, reason: 'timeout' });
    h.queryOne.mockResolvedValue(null);
    h.getDepartmentById.mockResolvedValue({ id: 150749, name: 'Новый отдел', parentId: 142365 });

    const created = await createSigurDepartment({ name: 'Новый отдел', parentId: 142365 });

    expect(created).toMatchObject({ mirrorReady: false, mirrorReason: 'timeout' });
  });

  it('отдел вне фильтра синхронизации: зеркало есть, но назначать нельзя', async () => {
    h.createDepartment.mockResolvedValue({ id: 150749 });
    h.queryOne.mockResolvedValue({ ...MIRRORED_ROW, is_assignable: false });
    h.getDepartmentById.mockResolvedValue({ id: 150749, name: 'Вне фильтра', parentId: null });

    const created = await createSigurDepartment({ name: 'Вне фильтра', parentId: null });

    expect(created).toMatchObject({ mirrorReady: true, mirrorReason: 'not_assignable' });
  });

  it('Sigur не вернул id: refresh всё равно запрошен — карточка отдела уже создана', async () => {
    h.createDepartment.mockResolvedValue({});

    await expect(createSigurDepartment({ name: 'Без id', parentId: null }))
      .rejects.toThrow('Sigur не вернул id созданного отдела');

    expect(h.requestRefresh).toHaveBeenCalledWith('admin_crud', undefined);
  });

  it('переименование: ответ после зеркала', async () => {
    h.updateDepartment.mockResolvedValue(undefined);
    h.getDepartmentById.mockResolvedValue({ id: 150749, name: 'Новое имя', parentId: null });

    const updated = await updateSigurDepartment(150749, { name: 'Новое имя' });

    expect(h.refreshNow).toHaveBeenCalledWith('admin_crud', undefined);
    expect(updated).toMatchObject({ name: 'Новое имя', mirrorReady: true });
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
    expect(h.refreshNow).toHaveBeenCalledWith('admin_crud', undefined);
  });
});
