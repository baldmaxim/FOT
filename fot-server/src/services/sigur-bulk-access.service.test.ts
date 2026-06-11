import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  getBindings: vi.fn(),
  replaceBindings: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  execute: h.execute,
}));
vi.mock('./sigur-linked-employees.service.js', () => ({
  getEmployeeAccessPointBindings: h.getBindings,
  replaceEmployeeAccessPointBindings: h.replaceBindings,
}));
vi.mock('./audit.service.js', () => ({
  auditService: { log: h.auditLog },
}));

const { bulkAddEmployeeAccessPointsStreaming } = await import('./sigur-bulk-access.service.js');

const noopProgress = () => undefined;

const replaceResult = (addedIds: number[], names: Array<[number, string]>) => ({
  addedIds,
  removedIds: [],
  bindings: names.map(([accessPointId, accessPointName]) => ({ accessPointId, accessPointName })),
  restoredCardIds: [],
  cardConflicts: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  h.query.mockResolvedValue([]); // нет связанных пропусков по умолчанию
  h.execute.mockResolvedValue(undefined);
  h.auditLog.mockResolvedValue(undefined);
});

describe('bulkAddEmployeeAccessPointsStreaming', () => {
  it('merge: к текущим точкам добавляет выбранные, ничего не снимает', async () => {
    h.getBindings.mockResolvedValue([{ accessPointId: 1, accessPointName: 'A' }]);
    h.replaceBindings.mockResolvedValue(replaceResult([2, 3], [[1, 'A'], [2, 'B'], [3, 'C']]));

    const result = await bulkAddEmployeeAccessPointsStreaming([100], [2, 3], undefined, 'admin', noopProgress);

    expect(result.updated).toBe(1);
    expect(result.failedIds).toEqual([]);
    const passedIds: number[] = h.replaceBindings.mock.calls[0][1];
    expect([...passedIds].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('связанный активный пропуск: обновляет contractor_passes и пишет audit', async () => {
    h.query.mockResolvedValue([
      { id: 'pass-1', sigur_employee_id: 200, pass_number: 'P-200', org_department_id: 'org-1' },
    ]);
    h.getBindings.mockResolvedValue([]);
    h.replaceBindings.mockResolvedValue(replaceResult([2], [[2, 'B']]));

    const result = await bulkAddEmployeeAccessPointsStreaming([200], [2], undefined, 'admin', noopProgress);

    expect(result.syncedPasses).toBe(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0][1]).toEqual([['B'], 'pass-1']);
    expect(h.auditLog).toHaveBeenCalledTimes(1);
    expect(h.auditLog.mock.calls[0][0]).toMatchObject({
      action: 'CONTRACTOR_PASS_ACCESS_POINTS_ADDED',
      entity_type: 'contractor_pass',
      entity_id: 'pass-1',
    });
  });

  it('ничего не добавилось (уже всё есть): пропуск не синхронизируется', async () => {
    h.query.mockResolvedValue([
      { id: 'pass-1', sigur_employee_id: 200, pass_number: 'P-200', org_department_id: 'org-1' },
    ]);
    h.getBindings.mockResolvedValue([{ accessPointId: 2, accessPointName: 'B' }]);
    h.replaceBindings.mockResolvedValue(replaceResult([], [[2, 'B']]));

    const result = await bulkAddEmployeeAccessPointsStreaming([200], [2], undefined, 'admin', noopProgress);

    expect(result.syncedPasses).toBe(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.auditLog).not.toHaveBeenCalled();
  });

  it('сотрудник без связанного пропуска: Sigur обновлён, contractor не трогается', async () => {
    h.getBindings.mockResolvedValue([]);
    h.replaceBindings.mockResolvedValue(replaceResult([5], [[5, 'E']]));

    const result = await bulkAddEmployeeAccessPointsStreaming([300], [5], undefined, 'admin', noopProgress);

    expect(result.updated).toBe(1);
    expect(result.syncedPasses).toBe(0);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('ошибка одного сотрудника не роняет пачку', async () => {
    h.getBindings.mockResolvedValue([]);
    h.replaceBindings.mockImplementation((employeeId: number) => {
      if (employeeId === 999) throw new Error('Sigur 500');
      return Promise.resolve(replaceResult([7], [[7, 'G']]));
    });

    const result = await bulkAddEmployeeAccessPointsStreaming([100, 999], [7], undefined, 'admin', noopProgress);

    expect(result.updated).toBe(1);
    expect(result.failedIds).toEqual([999]);
    expect(result.warnings.length).toBe(1);
  });
});
