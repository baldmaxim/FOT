import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const readScopeMock = vi.hoisted(() => vi.fn());
vi.mock('../services/employee-scope-filter.service.js', () => ({
  filterEmployeeIdsByReadScope: readScopeMock,
}));

const mainObjectsMock = vi.hoisted(() => vi.fn());
vi.mock('../services/employee-main-object-snapshot.service.js', () => ({
  loadMainObjects: mainObjectsMock,
}));

const costItemsMock = vi.hoisted(() => vi.fn());
vi.mock('../services/employee-cost-item.service.js', () => ({
  loadCostItems: costItemsMock,
}));

const LIVE_PERIOD = { start: '2026-08-16', end: '2026-09-14' };
const SNAPSHOT_PERIOD = { start: '2026-08-15', end: '2026-09-13' };

vi.mock('./employees-export.controller.js', () => ({
  resolveExportPeriod: () => ({ start: '2026-08-16', end: '2026-09-14' }),
}));


const { employeesMainObjectsController, parseEmployeeIdsParam, MAIN_OBJECTS_MAX_IDS, MAIN_OBJECTS_POST_MAX_IDS } =
  await import('./employees-main-objects.controller.js');

const makeRes = () => {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.payload = body; return res; },
  };
  return res;
};

const call = async (ids: unknown) => {
  const res = makeRes();
  await employeesMainObjectsController.getMainObjects(
    { query: { ids }, user: { id: 'u1' } } as unknown as AuthenticatedRequest,
    res as unknown as Response,
  );
  return res;
};

beforeEach(() => {
  readScopeMock.mockReset().mockImplementation(async (_req: unknown, ids: number[]) => ids);
  mainObjectsMock.mockReset().mockResolvedValue({ period: SNAPSHOT_PERIOD, objects: new Map(), objectNamesByEmployee: new Map(), source: 'snapshot' });
  costItemsMock.mockReset().mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, 'СКУД'])));
});

describe('parseEmployeeIdsParam', () => {
  it('разбирает и дедуплицирует, мусор — null', () => {
    expect(parseEmployeeIdsParam('3, 1,3')).toEqual([3, 1]);
    expect(parseEmployeeIdsParam('')).toEqual([]);
    expect(parseEmployeeIdsParam('1,abc')).toBeNull();
    expect(parseEmployeeIdsParam('1,-2')).toBeNull();
    expect(parseEmployeeIdsParam(undefined)).toBeNull();
  });
});

describe('GET /employees/main-objects', () => {
  it('некорректные id и больше лимита — 400 без расчёта', async () => {
    expect((await call('1,x')).statusCode).toBe(400);
    const tooMany = Array.from({ length: MAIN_OBJECTS_MAX_IDS + 1 }, (_, i) => i + 1).join(',');
    expect((await call(tooMany)).statusCode).toBe(400);
    expect(mainObjectsMock).not.toHaveBeenCalled();
  });

  it('читает объекты только по id из скоупа чтения, отдаёт период снимка', async () => {
    readScopeMock.mockResolvedValue([1]);
    const names = new Map([[1, ['ЖК Ситибэй', 'ЖК Wave']]]);
    mainObjectsMock.mockResolvedValue({ period: SNAPSHOT_PERIOD, objects: new Map([[1, 'ЖК Ситибэй']]), objectNamesByEmployee: names, source: 'snapshot' });
    costItemsMock.mockResolvedValue(new Map([[1, 'СКУД (ЖК Ситибэй, ЖК Wave)']]));

    const res = await call('1,2');

    expect(res.statusCode).toBe(200);
    expect(mainObjectsMock).toHaveBeenCalledWith([1], LIVE_PERIOD);
    expect(costItemsMock).toHaveBeenCalledWith([1], names);
    expect(res.payload).toEqual({
      success: true,
      data: {
        period: SNAPSHOT_PERIOD,
        objects: { 1: 'ЖК Ситибэй' },
        cost_items: { 1: 'СКУД (ЖК Ситибэй, ЖК Wave)' },
        source: 'snapshot',
      },
    });
  });

  it('cost_items — для каждого видимого id, даже без объекта в снимке', async () => {
    readScopeMock.mockResolvedValue([1, 2]);
    mainObjectsMock.mockResolvedValue({ period: SNAPSHOT_PERIOD, objects: new Map(), objectNamesByEmployee: new Map(), source: 'snapshot' });
    costItemsMock.mockResolvedValue(new Map([[1, 'Текущая деятельность'], [2, 'СКУД']]));

    const res = await call('1,2');

    expect((res.payload as { data: { cost_items: object } }).data.cost_items).toEqual({ 1: 'Текущая деятельность', 2: 'СКУД' });
  });

  it('снимка нет — ответ с периодом расчёта на лету', async () => {
    mainObjectsMock.mockResolvedValue({ period: LIVE_PERIOD, objects: new Map([[1, 'ЖК Wave']]), objectNamesByEmployee: new Map([[1, ['ЖК Wave']]]), source: 'live' });
    const res = await call('1');
    expect((res.payload as { data: { period: object; source: string } }).data).toMatchObject({ period: LIVE_PERIOD, source: 'live' });
  });

  it('никого не видно — чужие id в загрузку объектов не уходят', async () => {
    readScopeMock.mockResolvedValue([]);
    const res = await call('5');
    expect(mainObjectsMock).toHaveBeenCalledWith([], LIVE_PERIOD);
    expect((res.payload as { data: { objects: object } }).data.objects).toEqual({});
  });

  it('ошибка расчёта — 500', async () => {
    mainObjectsMock.mockRejectedValue(new Error('db'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call('1')).statusCode).toBe(500);
    err.mockRestore();
  });
});

const callPost = async (body: unknown) => {
  const res = makeRes();
  await employeesMainObjectsController.postMainObjects(
    { body, user: { id: 'u1' } } as unknown as AuthenticatedRequest,
    res as unknown as Response,
  );
  return res;
};

describe('POST /employees/main-objects', () => {
  it('пустой, некорректный и больше лимита — 400 без расчёта', async () => {
    expect((await callPost({ ids: [] })).statusCode).toBe(400);
    expect((await callPost({})).statusCode).toBe(400);
    expect((await callPost({ ids: [1, 'x'] })).statusCode).toBe(400);
    expect((await callPost({ ids: [1, -2] })).statusCode).toBe(400);
    expect((await callPost({ ids: [1.5] })).statusCode).toBe(400);
    const tooMany = Array.from({ length: MAIN_OBJECTS_POST_MAX_IDS + 1 }, (_, i) => i + 1);
    expect((await callPost({ ids: tooMany })).statusCode).toBe(400);
    expect(mainObjectsMock).not.toHaveBeenCalled();
  });

  it('1000 id принимаются, дубли схлопываются до проверки скоупа', async () => {
    const ids = Array.from({ length: MAIN_OBJECTS_POST_MAX_IDS }, (_, i) => i + 1);
    const res = await callPost({ ids: [...ids.slice(0, 5), ...ids] });
    expect(res.statusCode).toBe(200);
    expect(readScopeMock.mock.calls[0][1]).toEqual(ids);
  });

  it('вне скоупа — отброшены, в расчёт не уходят', async () => {
    readScopeMock.mockResolvedValue([2]);
    costItemsMock.mockResolvedValue(new Map([[2, 'СКУД']]));
    const res = await callPost({ ids: [1, 2] });
    expect(mainObjectsMock).toHaveBeenCalledWith([2], LIVE_PERIOD);
    expect((res.payload as { data: { cost_items: object } }).data.cost_items).toEqual({ 2: 'СКУД' });
  });
});
