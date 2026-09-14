import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const readScopeMock = vi.hoisted(() => vi.fn());
vi.mock('../services/employee-scope-filter.service.js', () => ({
  filterEmployeeIdsByReadScope: readScopeMock,
}));

const mainObjectsMock = vi.hoisted(() => vi.fn());
vi.mock('../services/employees-export-objects.service.js', () => ({
  loadMainObjectByEmployee: mainObjectsMock,
}));

vi.mock('./employees-export.controller.js', () => ({
  resolveExportPeriod: () => ({ start: '2026-08-16', end: '2026-09-14' }),
}));

const { employeesMainObjectsController, parseEmployeeIdsParam, MAIN_OBJECTS_MAX_IDS } =
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
  mainObjectsMock.mockReset().mockResolvedValue(new Map());
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

  it('считает только по id из скоупа чтения, отдаёт период', async () => {
    readScopeMock.mockResolvedValue([1]);
    mainObjectsMock.mockResolvedValue(new Map([[1, 'ЖК Ситибэй']]));

    const res = await call('1,2');

    expect(res.statusCode).toBe(200);
    expect(mainObjectsMock).toHaveBeenCalledWith([1], { start: '2026-08-16', end: '2026-09-14' });
    expect(res.payload).toEqual({
      success: true,
      data: { period: { start: '2026-08-16', end: '2026-09-14' }, objects: { 1: 'ЖК Ситибэй' } },
    });
  });

  it('никого не видно — без расчёта и пустой ответ', async () => {
    readScopeMock.mockResolvedValue([]);
    const res = await call('5');
    expect(mainObjectsMock).not.toHaveBeenCalled();
    expect((res.payload as { data: { objects: object } }).data.objects).toEqual({});
  });

  it('ошибка расчёта — 500', async () => {
    mainObjectsMock.mockRejectedValue(new Error('db'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call('1')).statusCode).toBe(500);
    err.mockRestore();
  });
});
