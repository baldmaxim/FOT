import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Пометка «версия устарела» при записи в закрытый период.
 *
 * Смысл: админ вправе править закрытый табель напрямую, и такая правка обязана дойти
 * до 1С так же, как правка через «Открыть → поправить → Закрыть».
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

import {
  checkClosedTimesheetWriteAndMarkDirty,
  markVersionDirty,
} from './timesheet-version.service.js';

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

describe('markVersionDirty', () => {
  it('метит только закрытые утверждённые подачи', async () => {
    const exec = makeExec();
    await markVersionDirty(exec as never, [855]);

    const sql = exec.calls[0]!.sql;
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('unlocked_at IS NULL');
  });

  it('инкрементит seq, а не просто обновляет время', async () => {
    // По одному timestamp правку, пришедшую во время сборки, отличить нельзя.
    const exec = makeExec();
    await markVersionDirty(exec as never, [855]);
    expect(exec.calls[0]!.sql).toContain('version_dirty_seq + 1');
  });

  it('сбрасывает счётчик неудач: новая правка могла устранить причину ошибки', async () => {
    const exec = makeExec();
    await markVersionDirty(exec as never, [855]);
    expect(exec.calls[0]!.sql).toContain('version_rebuild_attempts   = 0');
  });

  it('пустой список — запроса нет', async () => {
    const exec = makeExec();
    await markVersionDirty(exec as never, []);
    expect(exec.query).not.toHaveBeenCalled();
  });

  it('дубли id схлопываются', async () => {
    const exec = makeExec();
    await markVersionDirty(exec as never, [855, 855, 900]);
    expect(exec.calls[0]!.params[0]).toEqual([855, 900]);
  });
});

describe('checkClosedTimesheetWriteAndMarkDirty', () => {
  it('неадмин: возвращает замки по submitted И approved, метку не ставит', async () => {
    // Ключевая регрессия: если бы здесь использовался поиск только approved,
    // неадмины начали бы править табели, отправленные на проверку.
    findLocks.mockResolvedValue(new Map([['501|2026-08-05', { id: 855, status: 'submitted' }]]));
    const exec = makeExec();

    const locks = await checkClosedTimesheetWriteAndMarkDirty(false, PAIRS, exec as never);

    expect(locks.size).toBe(1);
    expect(findLocks).toHaveBeenCalledOnce();
    expect(listClosedIds).not.toHaveBeenCalled();
    expect(exec.query).not.toHaveBeenCalled();
  });

  it('админ: замков нет, помечены ВСЕ затронутые подачи', async () => {
    // Сотрудник может входить и в подачу отдела, и в персональную подачу
    // руководителя — правка его часов меняет обе версии.
    listClosedIds.mockResolvedValue([855, 900]);
    const exec = makeExec();

    const locks = await checkClosedTimesheetWriteAndMarkDirty(true, PAIRS, exec as never);

    expect(locks.size).toBe(0);
    expect(exec.calls[0]!.params[0]).toEqual([855, 900]);
    expect(exec.calls[0]!.sql).toContain('version_dirty_at');
  });

  it('админ: правка вне закрытых периодов метку не ставит', async () => {
    listClosedIds.mockResolvedValue([]);
    const exec = makeExec();

    await checkClosedTimesheetWriteAndMarkDirty(true, PAIRS, exec as never);

    expect(exec.query).not.toHaveBeenCalled();
  });

  it('пометка идёт через тот же exec, что и запись — откатится вместе с ней', async () => {
    listClosedIds.mockResolvedValue([855]);
    const exec = makeExec();

    await checkClosedTimesheetWriteAndMarkDirty(true, PAIRS, exec as never);

    expect(listClosedIds).toHaveBeenCalledWith(PAIRS, exec);
    expect(exec.query).toHaveBeenCalledOnce();
  });
});
