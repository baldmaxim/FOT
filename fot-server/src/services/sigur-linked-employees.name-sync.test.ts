import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * syncLinkedEmployeeFromSigur вызывается после правки карточки Sigur-связанного сотрудника.
 * ФИО он тянет из Sigur — значит и профиль портала должен приводиться к карточке
 * в той же транзакции (иначе в ЛК остаётся старая фамилия).
 */
const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  syncProfileName: vi.fn(),
  getEmployeeById: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('./user-profile-name.service.js', () => ({ syncProfileNameFromEmployee: h.syncProfileName }));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getEmployeeById: h.getEmployeeById,
    getDepartments: vi.fn(),
    getPositions: vi.fn(),
    createDepartment: vi.fn(),
    createPosition: vi.fn(),
    updateEmployee: vi.fn(),
  },
}));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { invalidate: h.invalidate } }));
vi.mock('./employee-mapper.service.js', () => ({ invalidateStructureCache: vi.fn() }));
vi.mock('./settings.service.js', () => ({
  settingsService: { getSigurConnectionSettings: vi.fn().mockResolvedValue({}) },
}));

import { syncLinkedEmployeeFromSigur } from './sigur-linked-employees.service.js';

const LINKED_ROW = {
  id: 396,
  sigur_employee_id: 127364,
  org_department_id: 'dept-1',
  position_id: 'pos-1',
  tab_number: '05510',
  full_name: 'Виноходова Екатерина Андреевна',
  last_name: 'Виноходова',
  first_name: 'Екатерина',
  middle_name: 'Андреевна',
  employment_status: 'active' as const,
  department_locked: false,
  name_locked: false,
};

/** Транзакция: собирает SQL, ушедшие по client.query. */
const collectTransaction = () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  }));
  return calls;
};

describe('syncLinkedEmployeeFromSigur — ФИО и профиль портала', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.execute.mockResolvedValue(1);
    h.syncProfileName.mockResolvedValue(1);
    // Отделы/должности резолвим в те же, что уже стоят у сотрудника.
    h.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM employees')) return LINKED_ROW;
      if (sql.includes('FROM org_departments')) return { id: 'dept-1' };
      if (sql.includes('FROM positions')) return { id: 'pos-1' };
      return null;
    });
  });

  it('новая фамилия из Sigur: карточка и профиль пишутся одной транзакцией', async () => {
    const calls = collectTransaction();
    h.getEmployeeById.mockResolvedValue({
      id: 127364, name: 'Чернышева Екатерина Андреевна', departmentId: 501, positionId: 601, position: 'Инженер', tabId: '05510',
    });

    const result = await syncLinkedEmployeeFromSigur(396);

    expect(result.fullName).toBe('Чернышева Екатерина Андреевна');
    expect(h.withTransaction).toHaveBeenCalledTimes(1);
    expect(calls[0].sql).toContain('UPDATE employees SET');
    expect(calls[0].params).toContain('Чернышева Екатерина Андреевна');
    expect(h.syncProfileName).toHaveBeenCalledTimes(1);
    expect(h.syncProfileName.mock.calls[0][1]).toBe(396);
  });

  it('name_locked: ФИО из Sigur не пишем и профиль не трогаем', async () => {
    collectTransaction();
    h.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM employees')) return { ...LINKED_ROW, name_locked: true };
      if (sql.includes('FROM org_departments')) return { id: 'dept-1' };
      if (sql.includes('FROM positions')) return { id: 'pos-1' };
      return null;
    });
    h.getEmployeeById.mockResolvedValue({
      id: 127364, name: 'Чернышева Екатерина Андреевна', departmentId: 501, positionId: 601, position: 'Инженер', tabId: '05510',
    });

    const result = await syncLinkedEmployeeFromSigur(396);

    expect(result.fullName).toBe('Виноходова Екатерина Андреевна');
    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.syncProfileName).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalled();
  });
});
