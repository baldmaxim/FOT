import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { TimesheetEntry, TimesheetObjectEntry } from '../types';
import {
  MODAL_DATA_MAX_AGE_MS,
  decideModalRefresh,
  pickModalDayData,
} from './timesheetModalRefresh';

const NOW = 1_800_000_000_000;

describe('decideModalRefresh', () => {
  it('свежие данные без запроса — окно сразу', () => {
    expect(decideModalRefresh([{ dataUpdatedAt: NOW - 5_000, isFetching: false }], NOW)).toBe('ready');
  });

  it('ровно на пороге ещё не перечитываем, после порога — перечитываем', () => {
    expect(decideModalRefresh([{ dataUpdatedAt: NOW - MODAL_DATA_MAX_AGE_MS, isFetching: false }], NOW)).toBe('ready');
    expect(decideModalRefresh([{ dataUpdatedAt: NOW - MODAL_DATA_MAX_AGE_MS - 1, isFetching: false }], NOW)).toBe('refetch');
  });

  it('старая сетка (случай 18.09: загружена до прихода проходов) — перечитываем', () => {
    expect(decideModalRefresh([{ dataUpdatedAt: NOW - 30 * 60_000, isFetching: false }], NOW)).toBe('refetch');
  });

  it('свежие данные, но запрос идёт — ждём его', () => {
    expect(decideModalRefresh([{ dataUpdatedAt: NOW - 1_000, isFetching: true }], NOW)).toBe('await');
  });

  it('устаревание важнее идущего запроса', () => {
    expect(decideModalRefresh([{ dataUpdatedAt: NOW - 120_000, isFetching: true }], NOW)).toBe('refetch');
  });

  it('запрос без данных (выключенный недоступный период) не считается устаревшим', () => {
    expect(decideModalRefresh([
      { dataUpdatedAt: NOW - 1_000, isFetching: false },
      { dataUpdatedAt: 0, isFetching: false },
    ], NOW)).toBe('ready');
  });

  it('режим «По сотруднику»: хватает одного устаревшего периода', () => {
    expect(decideModalRefresh([
      { dataUpdatedAt: NOW - 1_000, isFetching: false },
      { dataUpdatedAt: NOW - 2_000, isFetching: false },
      { dataUpdatedAt: NOW - 90_000, isFetching: false },
    ], NOW)).toBe('refetch');
  });

  it('пустой список запросов — окно сразу', () => {
    expect(decideModalRefresh([], NOW)).toBe('ready');
  });
});

const entry = (employeeId: number, workDate: string, extra: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  employee_id: employeeId,
  work_date: workDate,
  ...extra,
} as TimesheetEntry);

const objectEntry = (employeeId: number, workDate: string, objectKey: string): TimesheetObjectEntry => ({
  employee_id: employeeId,
  work_date: workDate,
  object_key: objectKey,
} as TimesheetObjectEntry);

describe('pickModalDayData', () => {
  it('берёт запись и объекты только нужного сотрудника и дня', () => {
    const result = pickModalDayData(
      [entry(1661, '2026-09-16'), entry(1661, '2026-09-17', { hours_worked: 8.3 }), entry(7, '2026-09-17')],
      [
        objectEntry(1661, '2026-09-17', 'primavera'),
        objectEntry(1661, '2026-09-17', 'citybay'),
        objectEntry(1661, '2026-09-16', 'wave'),
        objectEntry(7, '2026-09-17', 'citybay'),
      ],
      1661,
      '2026-09-17',
    );
    expect(result.entry?.hours_worked).toBe(8.3);
    expect(result.objects.map(item => item.object_key)).toEqual(['primavera', 'citybay']);
  });

  it('нет записи — null, объектов нет — пустой список', () => {
    expect(pickModalDayData([entry(1, '2026-09-01')], [], 1661, '2026-09-17')).toEqual({ entry: null, objects: [] });
  });

  it('повтор ключа — побеждает последняя запись, как в entryMap сетки', () => {
    const result = pickModalDayData(
      [entry(1661, '2026-09-17', { hours_worked: 6 }), entry(1661, '2026-09-17', { hours_worked: 8 })],
      [],
      1661,
      '2026-09-17',
    );
    expect(result.entry?.hours_worked).toBe(8);
  });
});

// Поведение React Query, на котором держится разблокировка окна: после refetch данные и
// isFetching меняются вместе; при ошибке старые данные остаются, а dataUpdatedAt не растёт.
describe('React Query: предпосылки обновления окна', () => {
  const createClient = (): QueryClient => new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } },
  });

  it('после успешного refetch данные свежие, запрос завершён, dataUpdatedAt вырос', async () => {
    const client = createClient();
    let version = 1;
    const observer = new QueryObserver(client, { queryKey: ['timesheet-page', 't1'], queryFn: async () => ({ version }) });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ version: 1 }));
    const firstUpdatedAt = observer.getCurrentResult().dataUpdatedAt;

    version = 2;
    await new Promise(resolve => setTimeout(resolve, 5));
    const result = await observer.refetch({ cancelRefetch: false });
    expect(result.isError).toBe(false);
    expect(result.data).toEqual({ version: 2 });
    expect(result.isFetching).toBe(false);
    expect(result.dataUpdatedAt).toBeGreaterThan(firstUpdatedAt);
    unsubscribe();
    client.clear();
  });

  it('ошибка refetch: isError, старые данные на месте, dataUpdatedAt не меняется → «Повторить» снова перечитает', async () => {
    const client = createClient();
    let fail = false;
    const observer = new QueryObserver(client, {
      queryKey: ['timesheet-page', 't2'],
      queryFn: async () => {
        if (fail) throw new Error('network');
        return { version: 1 };
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ version: 1 }));
    const updatedAt = observer.getCurrentResult().dataUpdatedAt;

    fail = true;
    const result = await observer.refetch({ cancelRefetch: false });
    expect(result.isError).toBe(true);
    expect(result.data).toEqual({ version: 1 });
    expect(result.dataUpdatedAt).toBe(updatedAt);
    expect(decideModalRefresh([result], updatedAt + MODAL_DATA_MAX_AGE_MS + 1)).toBe('refetch');
    unsubscribe();
    client.clear();
  });

  it('cancelRefetch: false переиспользует уже идущий запрос, а не шлёт второй', async () => {
    const client = createClient();
    const queryFn = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { ok: true };
    });
    const observer = new QueryObserver(client, { queryKey: ['timesheet-page', 't3'], queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    queryFn.mockClear();

    await Promise.all([
      observer.refetch({ cancelRefetch: false }),
      observer.refetch({ cancelRefetch: false }),
    ]);
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
    client.clear();
  });
});
