import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({ pgQuery: vi.fn(), pgQueryOne: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { payrollRatesController } from './payroll-rates.controller.js';

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

const duplicateError = () => Object.assign(new Error('duplicate key'), { code: '23505' });

beforeEach(() => {
  // resetAllMocks: очередь mockResolvedValueOnce из прошлого теста не должна дожить до следующего.
  vi.resetAllMocks();
});

describe('payrollRatesController.list', () => {
  it('ставки в порядке добавления', async () => {
    pgQuery.mockResolvedValue([{ id: 1, name: 'Монтажник', amount: '450.00' }, { id: 2, name: 'Сварщик', amount: null }]);
    const res = makeRes();

    await payrollRatesController.list(makeReq(), res);

    expect(res.body.data).toEqual([{ id: 1, name: 'Монтажник', amount: '450.00' }, { id: 2, name: 'Сварщик', amount: null }]);
    expect(String(pgQuery.mock.calls[0][0])).toMatch(/ORDER BY id/);
  });
});

describe('payrollRatesController.add', () => {
  it('пробелы в названии схлопываются, значение сохраняется, запись в аудит', async () => {
    pgQueryOne.mockResolvedValue({ id: 3, name: 'Монтажник 3 разряда', amount: '450.50' });
    const res = makeRes();

    await payrollRatesController.add(makeReq({ body: { name: ' Монтажник  3 разряда ', amount: 450.5 } }), res);

    expect(res.statusCode).toBe(200);
    expect(pgQueryOne.mock.calls[0][1]).toEqual(['Монтажник 3 разряда', 450.5]);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_RATE_ADDED',
      expect.objectContaining({ entityId: '3', details: { name: 'Монтажник 3 разряда', amount: '450.50' } }),
    );
  });

  it('значение не задано (нет поля или null) — NULL, а не 0; ноль — это ноль', async () => {
    pgQueryOne.mockResolvedValue({ id: 4, name: 'Сварщик', amount: null });

    await payrollRatesController.add(makeReq({ body: { name: 'Сварщик' } }), makeRes());
    await payrollRatesController.add(makeReq({ body: { name: 'Сварщик', amount: null } }), makeRes());
    await payrollRatesController.add(makeReq({ body: { name: 'Сварщик', amount: 0 } }), makeRes());

    expect(pgQueryOne.mock.calls.map(call => (call[1] as unknown[])[1])).toEqual([null, null, 0]);
  });

  it('кривое значение и название — 400 без записи', async () => {
    const bodies = [
      { name: 'Сварщик', amount: -1 },
      { name: 'Сварщик', amount: '450' },
      { name: 'Сварщик', amount: '' },
      { name: 'Сварщик', amount: 10_000_000_000 },
      { name: '   ', amount: 1 },
      { name: 'а'.repeat(101), amount: 1 },
    ];
    for (const body of bodies) {
      const res = makeRes();
      await payrollRatesController.add(makeReq({ body }), res);
      expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('такая ставка уже есть — 409, аудита нет', async () => {
    pgQueryOne.mockRejectedValue(duplicateError());
    const res = makeRes();

    await payrollRatesController.add(makeReq({ body: { name: 'сварщик', amount: 500 } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_RATE');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('payrollRatesController.update', () => {
  it('меняет название и значение, в аудит — было и стало', async () => {
    pgQueryOne.mockResolvedValue({ id: 3, name: 'Сварщик', amount: '520.00', prev_name: 'Сварщик', prev_amount: null });
    const res = makeRes();

    await payrollRatesController.update(makeReq({ params: { id: '3' }, body: { name: 'Сварщик', amount: 520 } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ id: 3, name: 'Сварщик', amount: '520.00' });
    expect(pgQueryOne.mock.calls[0][1]).toEqual([3, 'Сварщик', 520]);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_RATE_UPDATED',
      expect.objectContaining({
        entityId: '3',
        details: { from: { name: 'Сварщик', amount: null }, to: { name: 'Сварщик', amount: '520.00' } },
      }),
    );
  });

  it('значение очищено — NULL; ничего не изменилось — аудита нет', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 3, name: 'Сварщик', amount: null, prev_name: 'Сварщик', prev_amount: '520.00' });
    await payrollRatesController.update(makeReq({ params: { id: '3' }, body: { name: 'Сварщик', amount: null } }), makeRes());
    expect(pgQueryOne.mock.calls[0][1]).toEqual([3, 'Сварщик', null]);
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);

    pgQueryOne.mockResolvedValueOnce({ id: 3, name: 'Сварщик', amount: null, prev_name: 'Сварщик', prev_amount: null });
    await payrollRatesController.update(makeReq({ params: { id: '3' }, body: { name: 'Сварщик', amount: null } }), makeRes());
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
  });

  it('название занято — 409; ставки нет или id кривой — 404; кривое значение — 400', async () => {
    pgQueryOne.mockRejectedValueOnce(duplicateError());
    const duplicate = makeRes();
    await payrollRatesController.update(makeReq({ params: { id: '3' }, body: { name: 'Монтажник', amount: 1 } }), duplicate);
    expect(duplicate.statusCode).toBe(409);

    pgQueryOne.mockResolvedValueOnce(null);
    const missing = makeRes();
    await payrollRatesController.update(makeReq({ params: { id: '99' }, body: { name: 'Монтажник', amount: 1 } }), missing);
    expect(missing.statusCode).toBe(404);

    const callsBefore = pgQueryOne.mock.calls.length;
    const badId = makeRes();
    await payrollRatesController.update(makeReq({ params: { id: '1.5' }, body: { name: 'Монтажник', amount: 1 } }), badId);
    expect(badId.statusCode).toBe(404);

    const invalid = makeRes();
    await payrollRatesController.update(makeReq({ params: { id: '3' }, body: { name: 'Монтажник', amount: -5 } }), invalid);
    expect(invalid.statusCode).toBe(400);

    expect(pgQueryOne.mock.calls.length).toBe(callsBefore);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('payrollRatesController.remove', () => {
  it('ставка удаляется и пишется в аудит; её нет — 404', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 3, name: 'Сварщик', amount: '520.00' });
    const res = makeRes();
    await payrollRatesController.remove(makeReq({ params: { id: '3' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_RATE_DELETED',
      expect.objectContaining({ entityId: '3', details: { name: 'Сварщик', amount: '520.00' } }),
    );

    pgQueryOne.mockResolvedValueOnce(null);
    const missing = makeRes();
    await payrollRatesController.remove(makeReq({ params: { id: '99' } }), missing);
    expect(missing.statusCode).toBe(404);
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
  });
});
