import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../config/postgres.js', () => ({
  query: queryMock,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { employeesSectionDepartmentsController } = await import('./employees-section-departments.controller.js');

const SM_ROOT_ID = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';

const makeRes = () => {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.payload = body; return res; },
  };
  return res;
};

const call = async () => {
  const res = makeRes();
  await employeesSectionDepartmentsController.getSectionDepartments(
    { user: { id: 'u1' } } as unknown as AuthenticatedRequest,
    res as unknown as Response,
  );
  return res;
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /employees/section-departments', () => {
  it('раскладывает отделы по разделам как фильтр списка; «Прочие» не отдаются', async () => {
    queryMock.mockResolvedValue([
      { id: 'root', parent_id: null, name: 'Объект', kind: 'object' },
      { id: SU10_ROOT_ID, parent_id: 'root', name: 'ООО СУ-10', kind: 'department' },
      { id: 'su10-pto', parent_id: SU10_ROOT_ID, name: 'ПТО', kind: 'department' },
      { id: 'su10-brig', parent_id: SU10_ROOT_ID, name: 'Бригады', kind: 'department' },
      { id: 'su10-brig-1', parent_id: 'su10-brig', name: 'бр. Иванова', kind: 'brigade' },
      { id: SM_ROOT_ID, parent_id: 'root', name: 'Служба Механизации', kind: 'department' },
      { id: 'sm-garage', parent_id: SM_ROOT_ID, name: 'Гараж', kind: 'department' },
      { id: 'sm-brig-1', parent_id: SM_ROOT_ID, name: 'бр. Петрова', kind: 'brigade' },
      { id: 'contr', parent_id: 'root', name: 'Подрядные организации', kind: 'department' },
      { id: 'contr-1', parent_id: 'contr', name: 'АСТЕРУС', kind: 'department' },
      { id: 'fired', parent_id: 'root', name: 'Уволенные', kind: 'department' },
    ]);

    const res = await call();

    expect(res.statusCode).toBe(200);
    const { data } = res.payload as { data: Record<string, string[]> };
    expect(Object.keys(data).sort()).toEqual(['brigades', 'contractors', 'sm', 'su10']);
    // СУ-10 и СМ — со своими бригадами; «brigades» — прежний бакет для старых клиентов.
    expect(data.su10.sort()).toEqual([SU10_ROOT_ID, 'su10-brig', 'su10-brig-1', 'su10-pto'].sort());
    expect(data.brigades.sort()).toEqual(['sm-brig-1', 'su10-brig', 'su10-brig-1']);
    expect(data.sm.sort()).toEqual([SM_ROOT_ID, 'sm-brig-1', 'sm-garage'].sort());
    expect(data.contractors.sort()).toEqual(['contr', 'contr-1']);
    expect(Object.values(data).flat()).not.toContain('fired');
  });

  it('пустая структура — все 4 ключа с пустыми массивами', async () => {
    queryMock.mockResolvedValue([]);
    const res = await call();
    expect((res.payload as { data: object }).data).toEqual({ su10: [], sm: [], brigades: [], contractors: [] });
  });

  it('ошибка БД — 500', async () => {
    queryMock.mockRejectedValue(new Error('db'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call()).statusCode).toBe(500);
    err.mockRestore();
  });
});
