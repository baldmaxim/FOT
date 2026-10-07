/**
 * Контроллер истории карты Sigur: валидация ID и ошибки сервиса.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const h = vi.hoisted(() => ({ history: vi.fn() }));

vi.mock('../services/sigur-card-history.service.js', () => ({ getSigurCardHistory: h.history }));
vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { sigurAdminController } = await import('./sigur-admin.controller.js');

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
};

const makeReq = (sigurEmployeeId: string, cardId: string) => ({
  user: { id: 'user-1' },
  params: { sigurEmployeeId, cardId },
  query: {},
  body: {},
}) as unknown as AuthenticatedRequest;

describe('sigurAdminController.getEmployeeCardHistory', () => {
  beforeEach(() => {
    h.history.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it.each([
    ['0', '1430'],
    ['-1', '1430'],
    ['abc', '1430'],
    ['90329', '0'],
    ['90329', '-5'],
    ['90329', '1.5'],
  ])('ID %s / %s → 400', async (sigurEmployeeId, cardId) => {
    const res = makeRes();
    await sigurAdminController.getEmployeeCardHistory(makeReq(sigurEmployeeId, cardId), res);
    expect(res.statusCode).toBe(400);
    expect(h.history).not.toHaveBeenCalled();
  });

  it('отдаёт историю из сервиса', async () => {
    const entries = [{ id: '1', kind: 'update_card_binding' }];
    h.history.mockResolvedValue(entries);
    const res = makeRes();

    await sigurAdminController.getEmployeeCardHistory(makeReq('90329', '1430'), res);

    expect(h.history).toHaveBeenCalledWith(90329, 1430);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: entries });
  });

  it('ошибка сервиса → 500 с общим сообщением', async () => {
    h.history.mockRejectedValue(new Error('connection reset'));
    const res = makeRes();

    await sigurAdminController.getEmployeeCardHistory(makeReq('90329', '1430'), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Не удалось загрузить историю карты' });
  });
});
