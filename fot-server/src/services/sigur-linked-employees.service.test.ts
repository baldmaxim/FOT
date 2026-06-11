import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedState = vi.hoisted(() => ({
  bindings: [] as Array<Record<string, unknown>>,
  accessPointMap: new Map<number, string>(),
  cardBindings: [] as Array<Record<string, unknown>>,
  // Симуляция побочного эффекта Sigur при правке точек доступа:
  // 'drop' — карта слетает у сотрудника; 'move' — уезжает к apMutationMoveTo; 'none' — без эффекта.
  apMutationEffect: 'none' as 'drop' | 'move' | 'none',
  apMutationMoveTo: 0,
  applyApMutationSideEffect(employeeId: number) {
    if (this.apMutationEffect === 'drop') {
      this.cardBindings = this.cardBindings.filter(card => Number(card.employeeId) !== employeeId);
    } else if (this.apMutationEffect === 'move') {
      this.cardBindings = this.cardBindings.map(card =>
        Number(card.employeeId) === employeeId ? { ...card, employeeId: this.apMutationMoveTo } : card,
      );
    }
  },
  sigurServiceMock: {
    getEmployeeAccessPointBindings: vi.fn(async () => mockedState.bindings),
    getAccessPointMapCached: vi.fn(async () => mockedState.accessPointMap),
    createEmployeeAccessPointBindings: vi.fn(async (employeeIds: number[], accessPointIds: number[]) => {
      for (const employeeId of employeeIds) {
        for (const accessPointId of accessPointIds) {
          mockedState.bindings.push({ employeeId, accessPointId });
        }
        mockedState.applyApMutationSideEffect(employeeId);
      }
    }),
    deleteEmployeeAccessPointBindings: vi.fn(async (employeeIds: number[], accessPointIds: number[]) => {
      mockedState.bindings = mockedState.bindings.filter(binding => {
        const employeeId = Number(binding.employeeId);
        const accessPointId = Number(binding.accessPointId);
        return !employeeIds.includes(employeeId) || !accessPointIds.includes(accessPointId);
      });
      for (const employeeId of employeeIds) mockedState.applyApMutationSideEffect(employeeId);
    }),
    getCardBindings: vi.fn(async (filters?: { employeeId?: number; cardId?: number }) => {
      if (filters?.cardId != null) {
        return mockedState.cardBindings.filter(card => Number(card.cardId) === Number(filters.cardId));
      }
      if (filters?.employeeId != null) {
        return mockedState.cardBindings.filter(card => Number(card.employeeId) === Number(filters.employeeId));
      }
      return mockedState.cardBindings;
    }),
    createEmployeeCardBinding: vi.fn(async (
      employeeId: number,
      cardId: number,
      startDate: string,
      expirationDate: string,
      _connection: unknown,
      format?: string,
    ) => {
      mockedState.cardBindings.push({ employeeId, cardId, startDate, expirationDate, format });
    }),
    invalidateCardListCache: vi.fn(),
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

// Подгружается ленивым import() только при восстановлении карт — мокаем, чтобы не тянуть
// тяжёлый sigur-live-admin (цикл импортов) в тест.
vi.mock('./sigur-live-admin.service.js', () => ({
  invalidateSigurDirectoryCaches: vi.fn(),
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
    mockedState.cardBindings = [];
    mockedState.apMutationEffect = 'none';
    mockedState.apMutationMoveTo = 0;
    mockedState.sigurServiceMock.getEmployeeAccessPointBindings.mockClear();
    mockedState.sigurServiceMock.getAccessPointMapCached.mockClear();
    mockedState.sigurServiceMock.createEmployeeAccessPointBindings.mockClear();
    mockedState.sigurServiceMock.deleteEmployeeAccessPointBindings.mockClear();
    mockedState.sigurServiceMock.getCardBindings.mockClear();
    mockedState.sigurServiceMock.createEmployeeCardBinding.mockClear();
    mockedState.sigurServiceMock.invalidateCardListCache.mockClear();
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
      restoredCardIds: [],
      cardConflicts: [],
    });
  });

  it('restores a card that Sigur dropped as a side effect of editing access points', async () => {
    mockedState.cardBindings = [
      { employeeId: 77, cardId: 37370, startDate: '2026-06-06 21:00:00', expirationDate: '2026-12-31 20:59:59', format: 'W26' },
    ];
    mockedState.apMutationEffect = 'drop';

    const result = await replaceEmployeeAccessPointBindings(77, [10, 30, 50]);

    expect(mockedState.sigurServiceMock.createEmployeeCardBinding).toHaveBeenCalledWith(
      77, 37370, '2026-06-06 21:00:00', '2026-12-31 20:59:59', undefined, 'W26',
    );
    expect(mockedState.sigurServiceMock.invalidateCardListCache).toHaveBeenCalledTimes(1);
    expect(result.restoredCardIds).toEqual([37370]);
    expect(result.cardConflicts).toEqual([]);
    // карта снова привязана к 77
    expect(mockedState.cardBindings.some(c => Number(c.employeeId) === 77 && Number(c.cardId) === 37370)).toBe(true);
  });

  it('does not restore a card that meanwhile got bound to another employee', async () => {
    mockedState.cardBindings = [
      { employeeId: 77, cardId: 37370, startDate: '2026-06-06 21:00:00', expirationDate: '2026-12-31 20:59:59', format: 'W26' },
    ];
    mockedState.apMutationEffect = 'move';
    mockedState.apMutationMoveTo = 99;

    const result = await replaceEmployeeAccessPointBindings(77, [10, 30, 50]);

    expect(mockedState.sigurServiceMock.createEmployeeCardBinding).not.toHaveBeenCalled();
    expect(result.restoredCardIds).toEqual([]);
    expect(result.cardConflicts).toEqual([
      { cardId: 37370, boundToEmployeeId: 99, reason: 'bound_to_other' },
    ]);
  });

  it('does nothing to a card that stays bound after the access point change', async () => {
    mockedState.cardBindings = [
      { employeeId: 77, cardId: 37370, startDate: '2026-06-06 21:00:00', expirationDate: '2026-12-31 20:59:59', format: 'W26' },
    ];
    mockedState.apMutationEffect = 'none';

    const result = await replaceEmployeeAccessPointBindings(77, [10, 30, 50]);

    expect(mockedState.sigurServiceMock.createEmployeeCardBinding).not.toHaveBeenCalled();
    expect(result.restoredCardIds).toEqual([]);
    expect(result.cardConflicts).toEqual([]);
  });
});
