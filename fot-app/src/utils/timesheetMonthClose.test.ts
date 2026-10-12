import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type {
  ITimesheetMonthCloseDepartment,
  ITimesheetMonthCloseResponse,
  TimesheetMonthCloseStatus,
} from '../services/timesheetApprovalService';
import { collectDepartmentIssues, runTimesheetMonthClose } from './timesheetMonthClose';

const department = (
  id: string,
  first: TimesheetMonthCloseStatus,
  second: TimesheetMonthCloseStatus,
  reasons: [string?, string?] = [],
): ITimesheetMonthCloseDepartment => ({
  department_id: id,
  name: `Отдел ${id}`,
  halves: [
    { start_date: '2026-09-01', end_date: '2026-09-15', status: first, reason: reasons[0] },
    { start_date: '2026-09-16', end_date: '2026-09-30', status: second, reason: reasons[1] },
  ],
});

const ids = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `d${index + 1}`);
const NAMES = new Map(ids(30).map(id => [id, `Отдел ${id}`]));

describe('collectDepartmentIssues', () => {
  it('закрытый отдел — без записей', () => {
    expect(collectDepartmentIssues(department('a', 'closed', 'already_closed'), 'a')).toEqual([]);
  });

  it('одна причина на обе половины — одна запись за месяц', () => {
    const issues = collectDepartmentIssues(
      department('a', 'skipped', 'skipped', ['Ждёт согласования выходных', 'Ждёт согласования выходных']),
      'a',
    );

    expect(issues).toEqual([{
      departmentId: 'a', departmentName: 'Отдел a', periodLabel: '1–30 сен 2026', reason: 'Ждёт согласования выходных',
    }]);
  });

  it('пропущена одна половина — запись только по ней', () => {
    const issues = collectDepartmentIssues(department('a', 'closed', 'skipped', [undefined, 'Причина']), 'a');

    expect(issues.map(issue => [issue.periodLabel, issue.reason])).toEqual([['16–30 сен 2026', 'Причина']]);
  });

  it('разные причины — отдельные записи', () => {
    const issues = collectDepartmentIssues(department('a', 'skipped', 'skipped', ['Первая', 'Вторая']), 'a');

    expect(issues.map(issue => issue.reason)).toEqual(['Первая', 'Вторая']);
  });
});

describe('runTimesheetMonthClose', () => {
  it('шлёт чанками по 10, строго по очереди, и досылает remaining_ids', async () => {
    const calls: string[][] = [];
    const closeChunk = vi.fn(async (_month: string, chunk: string[]): Promise<ITimesheetMonthCloseResponse> => {
      calls.push(chunk);
      // Первый запрос успел только 4 отдела из 10.
      const handled = calls.length === 1 ? chunk.slice(0, 4) : chunk;
      return {
        results: handled.map(id => department(id, 'closed', 'closed')),
        remaining_ids: chunk.slice(handled.length),
      };
    });
    const progress: number[] = [];

    const result = await runTimesheetMonthClose({
      month: '2026-09', departmentIds: ids(12), nameById: NAMES, closeChunk,
      onProgress: done => progress.push(done),
    });

    expect(calls.map(chunk => chunk.length)).toEqual([10, 6, 2]);
    expect(calls[1][0]).toBe('d5');
    expect(progress).toEqual([0, 4, 10, 12]);
    expect(result).toEqual({ closedCount: 12, issues: [], fatalError: null });
  });

  it('нет прав или месяц не завершён — запуск останавливается целиком', async () => {
    const closeChunk = vi.fn(async () => {
      throw new ApiError('Месяц ещё не завершён', 409, 'MONTH_NOT_COMPLETED');
    });

    const result = await runTimesheetMonthClose({
      month: '2026-10', departmentIds: ids(25), nameById: NAMES, closeChunk, onProgress: () => undefined,
    });

    expect(closeChunk).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ closedCount: 0, issues: [], fatalError: 'Месяц ещё не завершён' });
  });

  it('таймаут одного чанка: его отделы в списке, остальные продолжаются', async () => {
    let call = 0;
    const closeChunk = vi.fn(async (_month: string, chunk: string[]): Promise<ITimesheetMonthCloseResponse> => {
      call += 1;
      if (call === 1) throw new ApiError('timeout', 0, 'TIMEOUT');
      return { results: chunk.map(id => department(id, 'closed', 'closed')), remaining_ids: [] };
    });

    const result = await runTimesheetMonthClose({
      month: '2026-09', departmentIds: ids(12), nameById: NAMES, closeChunk, onProgress: () => undefined,
    });

    expect(closeChunk).toHaveBeenCalledTimes(2);
    expect(result.fatalError).toBeNull();
    expect(result.closedCount).toBe(2);
    expect(result.issues).toHaveLength(10);
    expect(result.issues[0]).toEqual({
      departmentId: 'd1', departmentName: 'Отдел d1', periodLabel: null,
      reason: 'Сервер не ответил вовремя — повторите выгрузку',
    });
  });

  it('два сбоя подряд — сервер недоступен, остальные чанки не ждём', async () => {
    const closeChunk = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });

    const result = await runTimesheetMonthClose({
      month: '2026-09', departmentIds: ids(30), nameById: NAMES, closeChunk, onProgress: () => undefined,
    });

    expect(closeChunk).toHaveBeenCalledTimes(2);
    expect(result.issues).toHaveLength(20);
    expect(result.fatalError).toContain('сервер не отвечает');
  });

  it('сервер не продвинулся — не зацикливаемся', async () => {
    const closeChunk = vi.fn(async (_month: string, chunk: string[]): Promise<ITimesheetMonthCloseResponse> => ({
      results: [], remaining_ids: chunk,
    }));

    const result = await runTimesheetMonthClose({
      month: '2026-09', departmentIds: ids(3), nameById: NAMES, closeChunk, onProgress: () => undefined,
    });

    expect(closeChunk).toHaveBeenCalledTimes(1);
    expect(result.issues).toHaveLength(3);
  });

  it('пропущенные отделы попадают в список с периодом и причиной', async () => {
    const closeChunk = vi.fn(async (): Promise<ITimesheetMonthCloseResponse> => ({
      results: [
        department('d1', 'closed', 'closed'),
        department('d2', 'skipped', 'closed', ['Ждёт согласования выходных (дней: 2)']),
        department('d3', 'no_employees', 'no_employees'),
      ],
      remaining_ids: [],
    }));

    const result = await runTimesheetMonthClose({
      month: '2026-09', departmentIds: ids(3), nameById: NAMES, closeChunk, onProgress: () => undefined,
    });

    expect(result.closedCount).toBe(2);
    expect(result.issues).toEqual([{
      departmentId: 'd2', departmentName: 'Отдел d2', periodLabel: '1–15 сен 2026',
      reason: 'Ждёт согласования выходных (дней: 2)',
    }]);
  });
});
