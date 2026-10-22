import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Сервис ставок (история значений, транзакции) проверяет PG-тест; здесь — разбор запроса, границы месяца,
// ответы и аудит. Хелперы месяцев — настоящие.
const svc = vi.hoisted(() => ({
  listRates: vi.fn(),
  addRate: vi.fn(),
  updateRate: vi.fn(),
  deleteRate: vi.fn(),
}));

vi.mock('../services/payroll/payroll-rates.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/payroll/payroll-rates.service.js')>()),
  ...svc,
}));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { payrollRatesController } from './payroll-rates.controller.js';
import { currentRateMonth, shiftRateMonth } from '../services/payroll/payroll-rates.service.js';

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

const rate = (over: Record<string, unknown> = {}) => ({
  id: 3, name: 'Сварщик', amount: '520.00', code: null, values: [{ effective_from: '2000-01', amount: '520.00' }], ...over,
});

const update = async (body: Record<string, unknown>, id = '3') => {
  const res = makeRes();
  await payrollRatesController.update(makeReq({ params: { id }, body }), res);
  return res;
};

const CURRENT = currentRateMonth();

beforeEach(() => {
  // resetAllMocks: очередь mockResolvedValueOnce из прошлого теста не должна дожить до следующего.
  vi.resetAllMocks();
});

describe('payrollRatesController.list', () => {
  it('ставки с историей — как отдал сервис', async () => {
    svc.listRates.mockResolvedValue([rate()]);
    const res = makeRes();

    await payrollRatesController.list(makeReq(), res);

    expect(res.body.data).toEqual([rate()]);
  });
});

describe('payrollRatesController.add', () => {
  it('пробелы в названии схлопываются, значение сохраняется, запись в аудит', async () => {
    svc.addRate.mockResolvedValue(rate({ name: 'Монтажник 3 разряда', amount: '450.50' }));
    const res = makeRes();

    await payrollRatesController.add(makeReq({ body: { name: ' Монтажник  3 разряда ', amount: 450.5 } }), res);

    expect(res.statusCode).toBe(200);
    expect(svc.addRate).toHaveBeenCalledWith('Монтажник 3 разряда', 450.5);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_RATE_ADDED',
      expect.objectContaining({ entityId: '3', details: { name: 'Монтажник 3 разряда', amount: '450.50' } }),
    );
  });

  it('значение не задано (нет поля или null) — NULL, а не 0; ноль — это ноль; копейки как есть', async () => {
    svc.addRate.mockResolvedValue(rate({ amount: null, values: [] }));

    for (const body of [{ name: 'Сварщик' }, { name: 'Сварщик', amount: null }, { name: 'Сварщик', amount: 0 },
      { name: 'Сварщик', amount: 450.55 }]) {
      await payrollRatesController.add(makeReq({ body }), makeRes());
    }

    expect(svc.addRate.mock.calls.map(call => call[1])).toEqual([null, null, 0, 450.55]);
  });

  it('кривое значение и название — 400 без записи', async () => {
    const bodies = [
      { name: 'Сварщик', amount: -1 },
      { name: 'Сварщик', amount: '450' },
      { name: 'Сварщик', amount: '' },
      { name: 'Сварщик', amount: 10_000_000_000 },
      // третий знак после запятой NUMERIC(12,2) округлил бы молча
      { name: 'Сварщик', amount: 450.005 },
      { name: '   ', amount: 1 },
      { name: 'а'.repeat(101), amount: 1 },
    ];
    for (const body of bodies) {
      const res = makeRes();
      await payrollRatesController.add(makeReq({ body }), res);
      expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(svc.addRate).not.toHaveBeenCalled();
  });

  it('такая ставка уже есть — 409, аудита нет', async () => {
    svc.addRate.mockResolvedValue(null);
    const res = makeRes();

    await payrollRatesController.add(makeReq({ body: { name: 'сварщик', amount: 500 } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_RATE');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('payrollRatesController.update', () => {
  it('без месяца — с текущего месяца МСК; в аудит — было и стало в изменённом месяце', async () => {
    const value = { effective_month: CURRENT, from: '520.00', to: '600.00' };
    svc.updateRate.mockResolvedValue({ before: rate(), after: rate({ amount: '600.00' }), nameChanged: false, value });

    const res = await update({ name: 'Сварщик', amount: 600 });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(rate({ amount: '600.00' }));
    expect(svc.updateRate).toHaveBeenCalledWith(3, 'Сварщик', 600, CURRENT);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_RATE_UPDATED',
      expect.objectContaining({ entityId: '3', details: { value } }),
    );
  });

  it('будущее значение пишется в аудит, хотя значение на сегодня прежнее', async () => {
    const next = shiftRateMonth(CURRENT, 2);
    const value = { effective_month: next, from: '520.00', to: '700.00' };
    svc.updateRate.mockResolvedValue({ before: rate(), after: rate(), nameChanged: false, value });

    await update({ name: 'Сварщик', amount: 700, effective_month: next });

    expect(svc.updateRate).toHaveBeenCalledWith(3, 'Сварщик', 700, next);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_RATE_UPDATED',
      expect.objectContaining({ details: { value } }),
    );
  });

  it('переименование — в аудит название; ничего не изменилось — аудита нет', async () => {
    svc.updateRate.mockResolvedValueOnce({
      before: rate(), after: rate({ name: 'Сварщик 5 р.' }), nameChanged: true, value: null,
    });
    await update({ name: 'Сварщик 5 р.', amount: 520 });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_RATE_UPDATED',
      expect.objectContaining({ details: { name: { from: 'Сварщик', to: 'Сварщик 5 р.' } } }),
    );

    svc.updateRate.mockResolvedValueOnce({ before: rate(), after: rate(), nameChanged: false, value: null });
    await update({ name: 'Сварщик', amount: 520 });
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
  });

  it('месяц: текущий и +12 — можно; прошлый — PAST_MONTH; +13 — MONTH_TOO_FAR; 00 и 13 — 400', async () => {
    svc.updateRate.mockResolvedValue({ before: rate(), after: rate(), nameChanged: false, value: null });
    const year = CURRENT.slice(0, 4);

    for (const month of [CURRENT, shiftRateMonth(CURRENT, 12)]) {
      expect((await update({ name: 'Сварщик', amount: 1, effective_month: month })).statusCode, month).toBe(200);
    }
    const past = await update({ name: 'Сварщик', amount: 1, effective_month: shiftRateMonth(CURRENT, -1) });
    expect([past.statusCode, past.body.code]).toEqual([400, 'PAST_MONTH']);
    const far = await update({ name: 'Сварщик', amount: 1, effective_month: shiftRateMonth(CURRENT, 13) });
    expect([far.statusCode, far.body.code]).toEqual([400, 'MONTH_TOO_FAR']);
    for (const month of [`${year}-00`, `${year}-13`, `${year}-1`, '2026-10-01']) {
      expect((await update({ name: 'Сварщик', amount: 1, effective_month: month })).statusCode, month).toBe(400);
    }

    expect(svc.updateRate).toHaveBeenCalledTimes(2);
  });

  it('название занято — 409; ставки нет или id кривой — 404; кривое значение — 400', async () => {
    svc.updateRate.mockResolvedValueOnce('duplicate');
    expect((await update({ name: 'Монтажник', amount: 1 })).statusCode).toBe(409);

    svc.updateRate.mockResolvedValueOnce(null);
    expect((await update({ name: 'Монтажник', amount: 1 }, '99')).statusCode).toBe(404);

    expect((await update({ name: 'Монтажник', amount: 1 }, '1.5')).statusCode).toBe(404);
    expect((await update({ name: 'Монтажник', amount: -5 })).statusCode).toBe(400);

    expect(svc.updateRate).toHaveBeenCalledTimes(2);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('ставка с кодом («Доплата за проживание», миграции 313/315)', () => {
  it('у ставки с кодом сменили название — 409 SYSTEM_RATE без аудита', async () => {
    svc.updateRate.mockResolvedValueOnce('system_name');

    const renamed = await update({ name: 'Проживание', amount: 700 }, '1');

    expect(renamed.statusCode).toBe(409);
    expect(renamed.body.code).toBe('SYSTEM_RATE');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('удалить нельзя — 409 без аудита', async () => {
    svc.deleteRate.mockResolvedValueOnce('system');
    const res = makeRes();
    await payrollRatesController.remove(makeReq({ params: { id: '1' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('Эту ставку удалить нельзя');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('payrollRatesController.remove', () => {
  it('ставка удаляется и пишется в аудит; её нет — 404', async () => {
    svc.deleteRate.mockResolvedValueOnce({ id: 3, name: 'Сварщик', amount: '520.00', code: null });
    const res = makeRes();
    await payrollRatesController.remove(makeReq({ params: { id: '3' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_RATE_DELETED',
      expect.objectContaining({ entityId: '3', details: { name: 'Сварщик', amount: '520.00' } }),
    );

    svc.deleteRate.mockResolvedValueOnce(null);
    const missing = makeRes();
    await payrollRatesController.remove(makeReq({ params: { id: '99' } }), missing);
    expect(missing.statusCode).toBe(404);
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
  });
});
