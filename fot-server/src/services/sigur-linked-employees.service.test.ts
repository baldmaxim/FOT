import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedState = vi.hoisted(() => ({
  bindings: [] as Array<Record<string, unknown>>,
  accessPointMap: new Map<number, string>(),
  sigurServiceMock: {
    getEmployeeAccessPointBindings: vi.fn(async () => mockedState.bindings),
    getAccessPointMapCached: vi.fn(async () => mockedState.accessPointMap),
    createEmployeeAccessPointBindings: vi.fn(async (employeeIds: number[], accessPointIds: number[]) => {
      for (const employeeId of employeeIds) {
        for (const accessPointId of accessPointIds) {
          mockedState.bindings.push({ employeeId, accessPointId });
        }
      }
    }),
    deleteEmployeeAccessPointBindings: vi.fn(async (employeeIds: number[], accessPointIds: number[]) => {
      mockedState.bindings = mockedState.bindings.filter(binding => {
        const employeeId = Number(binding.employeeId);
        const accessPointId = Number(binding.accessPointId);
        return !employeeIds.includes(employeeId) || !accessPointIds.includes(accessPointId);
      });
    }),
  },
}));

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

vi.mock('../utils/fio.utils.js', () => ({
  parseFIO: vi.fn(() => ({
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович',
  })),
}));

vi.mock('./employee-cache.service.js', () => ({
  employeeCache: {
    invalidate: vi.fn(),
  },
}));

vi.mock('./employee-mapper.service.js', () => ({
  invalidateStructureCache: vi.fn(),
}));

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getSigurConnectionSettings: vi.fn(async () => ({
      internal: { url: '', username: '', hasPassword: false, source: 'unset' },
      external: { url: '', username: '', hasPassword: false, source: 'unset' },
      archiveDepartmentId: null,
      archiveDepartmentName: null,
    })),
    setSigurConnectionSettings: vi.fn(async () => undefined),
  },
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: mockedState.sigurServiceMock,
}));

import {
  getEmployeeAccessPointBindings,
  replaceEmployeeAccessPointBindings,
} from './sigur-linked-employees.service.js';

describe('sigur-linked-employees access point helpers', () => {
  beforeEach(() => {
    mockedState.bindings = [
      { employeeId: 77, accessPointId: 10 },
      { employeeId: 77, accessPointId: 30 },
      { employeeId: 99, accessPointId: 50 },
    ];
    mockedState.accessPointMap = new Map([
      [10, 'КПП Север'],
      [20, 'КПП Юг'],
      [30, 'Проходная 1'],
      [50, 'Склад'],
    ]);
    mockedState.sigurServiceMock.getEmployeeAccessPointBindings.mockClear();
    mockedState.sigurServiceMock.getAccessPointMapCached.mockClear();
    mockedState.sigurServiceMock.createEmployeeAccessPointBindings.mockClear();
    mockedState.sigurServiceMock.deleteEmployeeAccessPointBindings.mockClear();
  });

  it('returns only bindings for selected employee and enriches names', async () => {
    const bindings = await getEmployeeAccessPointBindings(77);

    expect(bindings).toEqual([
      { accessPointId: 10, accessPointName: 'КПП Север' },
      { accessPointId: 30, accessPointName: 'Проходная 1' },
    ]);
  });

  it('replaces employee bindings through add/remove diff', async () => {
    const result = await replaceEmployeeAccessPointBindings(77, [20, 30]);

    expect(mockedState.sigurServiceMock.deleteEmployeeAccessPointBindings).toHaveBeenCalledWith([77], [10], undefined);
    expect(mockedState.sigurServiceMock.createEmployeeAccessPointBindings).toHaveBeenCalledWith([77], [20], undefined);
    expect(result).toEqual({
      addedIds: [20],
      removedIds: [10],
      bindings: [
        { accessPointId: 20, accessPointName: 'КПП Юг' },
        { accessPointId: 30, accessPointName: 'Проходная 1' },
      ],
    });
  });
});
