import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Подвиды видов удержаний (миграция 321): одни обработчики у кадров и «Зарплаты». SQL — настоящий сервис
// поверх замоканного pg: проверяются ответы, аудит и разбор ошибок БД.

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({ pgQuery: vi.fn(), pgQueryOne: vi.fn() }));
vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { deductionSubkindsController as c } from './deduction-subkinds.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest => ({
  user: { id: 'user-1' }, params: {}, query: {}, body: {}, ...over,
} as unknown as AuthenticatedRequest);

const pgError = (code: string, constraint?: string) => Object.assign(new Error(`pg ${code}`), { code, constraint });

const HELMET = { id: 9, kind_id: 4, name: 'Каска', default_amount: '800.00' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('дерево видов', () => {
  it('виды по порядку справочника, подвиды по порядку добавления — как вернула БД', async () => {
    const tree = [
      { id: 4, name: 'Спецодежда', default_amount: null, subkinds: [HELMET] },
      { id: 6, name: 'Штрафы', default_amount: '1000.00', subkinds: [] },
    ];
    pgQuery.mockResolvedValue(tree);
    const res = makeRes();
    await c.listKindTree(makeReq(), res);
    expect(res.body.data).toEqual(tree);
    const sql = String(pgQuery.mock.calls[0][0]);
    expect(sql).toMatch(/ORDER BY s\.id/);
    expect(sql).toMatch(/ORDER BY k\.sort_order, k\.id/);
  });
});

describe('добавить подвид', () => {
  it('пробелы схлопываются, сумма необязательна; аудит', async () => {
    pgQueryOne.mockResolvedValue(HELMET);
    const res = makeRes();
    await c.add(makeReq({ params: { id: '4' }, body: { name: '  Каска  защитная ', default_amount: 800 } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(HELMET);
    expect(pgQueryOne.mock.calls[0][1]).toEqual([4, 'Каска защитная', 800]);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_SUBKIND_ADDED',
      expect.objectContaining({ entityId: '9', details: { kind_id: 4, name: 'Каска', default_amount: '800.00' } }),
    );

    pgQueryOne.mockResolvedValue({ ...HELMET, default_amount: null });
    await c.add(makeReq({ params: { id: '4' }, body: { name: 'Каска' } }), makeRes());
    expect(pgQueryOne.mock.calls[1][1]).toEqual([4, 'Каска', null]);
  });

  it('такой у вида уже есть — 409; вида нет — 404; пустое название, сумма 0, кривой id — без записи', async () => {
    pgQueryOne.mockRejectedValueOnce(pgError('23505'));
    const duplicate = makeRes();
    await c.add(makeReq({ params: { id: '4' }, body: { name: 'каска' } }), duplicate);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_SUBKIND');

    pgQueryOne.mockRejectedValueOnce(pgError('23503'));
    const noKind = makeRes();
    await c.add(makeReq({ params: { id: '99' }, body: { name: 'Каска' } }), noKind);
    expect(noKind.statusCode).toBe(404);

    const calls = pgQueryOne.mock.calls.length;
    for (const [id, body, status] of [
      ['4', { name: '  ' }, 400],
      ['4', { name: 'Каска', default_amount: 0 }, 400],
      ['4', { name: 'Каска', default_amount: 800.005 }, 400],
      ['x', { name: 'Каска' }, 404],
    ] as const) {
      const res = makeRes();
      await c.add(makeReq({ params: { id }, body }), res);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
    }
    expect(pgQueryOne.mock.calls.length).toBe(calls);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('изменить подвид', () => {
  it('было и стало в аудите; без изменений — аудита нет; занято — 409; нет — 404', async () => {
    pgQueryOne.mockResolvedValueOnce({
      id: 9, kind_id: 4, name: 'Каска', default_amount: '900.00', previous_name: 'Каска', previous_amount: '800.00',
    });
    const res = makeRes();
    await c.update(makeReq({ params: { id: '9' }, body: { name: 'Каска', default_amount: 900 } }), res);
    expect(res.body.data).toEqual({ id: 9, kind_id: 4, name: 'Каска', default_amount: '900.00' });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_SUBKIND_UPDATED',
      expect.objectContaining({
        details: {
          from: { kind_id: 4, name: 'Каска', default_amount: '800.00' },
          to: { kind_id: 4, name: 'Каска', default_amount: '900.00' },
        },
      }),
    );

    pgQueryOne.mockResolvedValueOnce({ ...HELMET, previous_name: 'Каска', previous_amount: '800.00' });
    await c.update(makeReq({ params: { id: '9' }, body: { name: 'Каска', default_amount: 800 } }), makeRes());
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);

    pgQueryOne.mockRejectedValueOnce(pgError('23505'));
    const duplicate = makeRes();
    await c.update(makeReq({ params: { id: '9' }, body: { name: 'Перчатки' } }), duplicate);
    expect(duplicate.statusCode).toBe(409);

    pgQueryOne.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.update(makeReq({ params: { id: '99' }, body: { name: 'Каска' } }), missing);
    expect(missing.statusCode).toBe(404);
  });
});

describe('удалить подвид', () => {
  it('свободный — удалён, в аудите название и вид', async () => {
    pgQueryOne.mockResolvedValue(HELMET);
    const res = makeRes();
    await c.remove(makeReq({ params: { id: '9' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(HELMET);
    expect(String(pgQueryOne.mock.calls[0][0])).toMatch(/DELETE FROM payroll_deduction_subkinds/);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_SUBKIND_DELETED',
      expect.objectContaining({ entityId: '9', details: { kind_id: 4, name: 'Каска', default_amount: '800.00' } }),
    );
  });

  // 23503 — код внешнего ключа до PostgreSQL 18, 23001 — код ON DELETE RESTRICT с 18-й версии.
  it.each(['23503', '23001'])('назначен сотрудникам (код %s) — 409 с их числом, аудита нет', async code => {
    pgQueryOne.mockRejectedValueOnce(pgError(code)).mockResolvedValueOnce({ total: 2 });
    const res = makeRes();
    await c.remove(makeReq({ params: { id: '9' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'SUBKIND_IN_USE', employees: 2, error: 'Подвид назначен сотрудникам: 2' });
    expect(String(pgQueryOne.mock.calls[1][0])).toMatch(/FROM staff_deductions WHERE subkind_id/);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('нет или кривой id — 404', async () => {
    pgQueryOne.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.remove(makeReq({ params: { id: '99' } }), missing);
    expect(missing.statusCode).toBe(404);

    const bad = makeRes();
    await c.remove(makeReq({ params: { id: '0' } }), bad);
    expect(bad.statusCode).toBe(404);
    expect(pgQueryOne).toHaveBeenCalledTimes(1);
  });
});
