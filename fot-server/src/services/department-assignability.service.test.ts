import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Назначаемость отдела: отдел, оставленный активным ради числящихся сотрудников,
 * виден и доступен для просмотра, но принимать новых людей не должен.
 */

const h = vi.hoisted(() => ({ queryOne: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ queryOne: h.queryOne }));

import {
  assertSigurDepartmentAssignable,
  loadAssignableTargetDepartment,
  loadDepartmentRow,
} from './department-assignability.service.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'dept-1',
  sigur_department_id: 151392,
  name: 'Департамент МТО',
  is_active: true,
  is_assignable: true,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadAssignableTargetDepartment', () => {
  it('возвращает отдел, если он активен и назначаем', async () => {
    h.queryOne.mockResolvedValueOnce(row());

    await expect(loadAssignableTargetDepartment('dept-1')).resolves.toMatchObject({ id: 'dept-1' });
  });

  it('неназначаемый отдел — 409 с кодом', async () => {
    h.queryOne.mockResolvedValueOnce(row({ is_assignable: false }));

    await expect(loadAssignableTargetDepartment('dept-1')).rejects.toMatchObject({
      status: 409,
      code: 'DEPARTMENT_NOT_ASSIGNABLE',
    });
  });

  it('неактивный отдел — 400', async () => {
    h.queryOne.mockResolvedValueOnce(row({ is_active: false }));

    await expect(loadAssignableTargetDepartment('dept-1')).rejects.toMatchObject({ status: 400 });
  });

  it('ручной отдел без привязки к Sigur допустим, когда Sigur не требуется', async () => {
    h.queryOne.mockResolvedValueOnce(row({ sigur_department_id: null }));

    await expect(
      loadAssignableTargetDepartment('dept-1', { requireSigur: false }),
    ).resolves.toMatchObject({ sigur_department_id: null });
  });

  it('ручной отдел отклоняется, когда операция завязана на Sigur', async () => {
    h.queryOne.mockResolvedValueOnce(row({ sigur_department_id: null }));

    await expect(loadAssignableTargetDepartment('dept-1')).rejects.toMatchObject({
      status: 409,
      code: 'DEPARTMENT_WITHOUT_SIGUR',
    });
  });
});

describe('loadDepartmentRow', () => {
  it('отдаёт даже неактивный отдел — нужен для аудита исходного отдела перевода', async () => {
    h.queryOne.mockResolvedValueOnce(row({ is_active: false, is_assignable: false }));

    await expect(loadDepartmentRow('dept-1')).resolves.toMatchObject({ is_active: false });
  });
});

describe('assertSigurDepartmentAssignable', () => {
  it('пропускает архивную папку «Уволенные» — через неё идёт увольнение', async () => {
    await expect(
      assertSigurDepartmentAssignable(777, { archiveDepartmentId: 777 }),
    ).resolves.toBeUndefined();

    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it('отдел без строки в зеркале — 409 DEPARTMENT_NOT_MIRRORED', async () => {
    h.queryOne.mockResolvedValueOnce(null);

    await expect(assertSigurDepartmentAssignable(151392)).rejects.toMatchObject({
      status: 409,
      code: 'DEPARTMENT_NOT_MIRRORED',
    });
  });

  it('зеркалируемый, но неназначаемый отдел — 409 DEPARTMENT_NOT_ASSIGNABLE', async () => {
    h.queryOne.mockResolvedValueOnce(row({ is_assignable: false }));

    await expect(assertSigurDepartmentAssignable(151392)).rejects.toMatchObject({
      status: 409,
      code: 'DEPARTMENT_NOT_ASSIGNABLE',
    });
  });
});
