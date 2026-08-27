import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Замок закрытого периода и аварийная пометка версии.
 *
 * Смысл: закрытый согласованный табель неизменяем ДЛЯ ВСЕХ, включая is_admin — правки
 * идут только через «Открыть → поправить → Закрыть». Пометка версии осталась, но уже
 * не как путь для админа, а как операторская процедура восстановления после ручной
 * правки БД (timesheet-version-maintenance.ts).
 */

const { findLocks, listClosedIds } = vi.hoisted(() => ({
  findLocks: vi.fn(),
  listClosedIds: vi.fn(),
}));

vi.mock('./timesheet-lock.service.js', () => ({
  findApprovalLocksForEmployeeDates: findLocks,
  listClosedApprovalIdsForPairs: listClosedIds,
}));

vi.mock('./timesheet-export.service.js', () => ({ fetchTimesheetDataForEmployees: vi.fn() }));
vi.mock('./attendance.service.js', () => ({ hasRealActivity: vi.fn() }));
vi.mock('./timesheet-approval-employees-snapshot.service.js', () => ({ listApprovalEmployees: vi.fn() }));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeMembershipsForDepartmentPeriod: vi.fn(),
}));
vi.mock('../controllers/timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: vi.fn(),
}));

import { loadClosedTimesheetLocks } from './timesheet-version.service.js';
import { markVersionDirtyForOperatorRebuild } from './timesheet-version-maintenance.js';

function makeExec() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }),
  };
}

const PAIRS = [{ employeeId: 501, workDate: '2026-08-05' }];

beforeEach(() => {
  vi.clearAllMocks();
  findLocks.mockResolvedValue(new Map());
  listClosedIds.mockResolvedValue([]);
});

describe('markVersionDirtyForOperatorRebuild', () => {
  it('метит только закрытые утверждённые подачи', async () => {
    const exec = makeExec();
    await markVersionDirtyForOperatorRebuild(exec as never, [855]);

    const sql = exec.calls[0]!.sql;
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('unlocked_at IS NULL');
  });

  it('инкрементит seq, а не просто обновляет время', async () => {
    // По одному timestamp правку, пришедшую во время сборки, отличить нельзя.
    const exec = makeExec();
    await markVersionDirtyForOperatorRebuild(exec as never, [855]);
    expect(exec.calls[0]!.sql).toContain('version_dirty_seq + 1');
  });

  it('сбрасывает счётчик неудач: новая правка могла устранить причину ошибки', async () => {
    const exec = makeExec();
    await markVersionDirtyForOperatorRebuild(exec as never, [855]);
    expect(exec.calls[0]!.sql).toContain('version_rebuild_attempts   = 0');
  });

  it('пустой список — запроса нет', async () => {
    const exec = makeExec();
    await markVersionDirtyForOperatorRebuild(exec as never, []);
    expect(exec.query).not.toHaveBeenCalled();
  });

  it('дубли id схлопываются', async () => {
    const exec = makeExec();
    await markVersionDirtyForOperatorRebuild(exec as never, [855, 855, 900]);
    expect(exec.calls[0]!.params[0]).toEqual([855, 900]);
  });
});

describe('loadClosedTimesheetLocks', () => {
  it('возвращает замки по submitted И approved', async () => {
    // Ключевая регрессия: если бы здесь использовался поиск только approved,
    // правки поехали бы в табели, отправленные на проверку.
    findLocks.mockResolvedValue(new Map([['501|2026-08-05', { id: 855, status: 'submitted' }]]));
    const exec = makeExec();

    const locks = await loadClosedTimesheetLocks(PAIRS, exec as never);

    expect(locks.size).toBe(1);
    expect(findLocks).toHaveBeenCalledOnce();
  });

  it('привилегий нет ни у кого: результат не зависит от роли вызывающего', async () => {
    // Раньше здесь была ветка для is_admin, отдававшая пустую карту «замков нет».
    // Теперь у функции нет самого параметра роли — обойти замок нечем.
    findLocks.mockResolvedValue(new Map([['501|2026-08-05', { id: 855, status: 'approved' }]]));
    const exec = makeExec();

    const locks = await loadClosedTimesheetLocks(PAIRS, exec as never);

    expect(locks.size).toBe(1);
    expect(loadClosedTimesheetLocks.length).toBe(2);
  });

  it('штатная запись НЕ помечает версию на пересборку', async () => {
    // Инвариант для 1С: новая редакция появляется только при approve и close.
    // Если запись начнёт снова ставить version_dirty_at, табель станет пропадать
    // из выдачи 1С на время фоновой пересборки.
    findLocks.mockResolvedValue(new Map());
    const exec = makeExec();

    await loadClosedTimesheetLocks(PAIRS, exec as never);

    expect(listClosedIds).not.toHaveBeenCalled();
    expect(exec.query).not.toHaveBeenCalled();
  });

  it('открытый период правку пропускает: замков нет — записи ничего не мешает', async () => {
    findLocks.mockResolvedValue(new Map());
    const exec = makeExec();

    const locks = await loadClosedTimesheetLocks(PAIRS, exec as never);

    expect(locks.size).toBe(0);
  });
});
