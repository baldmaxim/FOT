import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

// Контракт ведомостей выплаты по API: право ключа, тип тела, dry_run, ошибки сервиса (busy с Retry-After, конфликт),
// разбор отмены, 413. Сервис замокан — запись проверяет payroll-1c-payouts.api.pg.test.ts.

const { applyPayoutsApi, cancelPayoutsApi } = vi.hoisted(() => ({ applyPayoutsApi: vi.fn(), cancelPayoutsApi: vi.fn() }));

vi.mock('../services/payroll/payroll-1c-payouts.api.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/payroll/payroll-1c-payouts.api.service.js')>()),
  applyPayoutsApi,
  cancelPayoutsApi,
}));

import { PayoutApiError } from '../services/payroll/payroll-1c-payouts.api.service.js';
import { Payout1cParseError } from '../services/payroll/payroll-1c-payouts.parser.js';
import { payoutsBodyErrorHandler, publicPayoutsController } from './public-payouts.controller.js';

const G = '11111111-1111-4111-8111-111111111111';
const makeReq = (input: { allow?: boolean; withKey?: boolean; type?: string; body?: unknown; query?: Record<string, string> }): Request => ({
  query: input.query ?? {},
  headers: { 'content-type': input.type ?? 'application/xml; charset=utf-8' },
  body: input.body,
  dataApiKey: input.withKey === false ? undefined : { id: 'key-1', name: 'api_1C', rate_limit_per_minute: 300, allow_payroll_payouts_import: input.allow ?? true },
}) as unknown as Request;
const makeRes = () => {
  const response = {
    statusCode: 200, payload: null as unknown, headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: any; headers: Record<string, string> };
};
const xmlBody = Buffer.from('<зп_документы_31/>', 'utf8');

describe('public-payouts.controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyPayoutsApi.mockResolvedValue([{ guid: G, action: 'new' }]);
    cancelPayoutsApi.mockResolvedValue([{ index: 0, guid: G, version: 3, action: 'cancelled' }]);
  });

  it('без права — 403, без ключа — 401', async () => {
    const forbidden = makeRes();
    await publicPayoutsController.post(makeReq({ allow: false, body: xmlBody }), forbidden);
    expect(forbidden.statusCode).toBe(403);
    const unauthorized = makeRes();
    await publicPayoutsController.cancel(makeReq({ withKey: false, body: {} }), unauthorized);
    expect(unauthorized.statusCode).toBe(401);
    expect(applyPayoutsApi).not.toHaveBeenCalled();
  });

  it('приём: тип тела, пустое тело, dry_run, ответ', async () => {
    const wrongType = makeRes();
    await publicPayoutsController.post(makeReq({ type: 'application/json', body: {} }), wrongType);
    expect(wrongType.statusCode).toBe(415);
    const empty = makeRes();
    await publicPayoutsController.post(makeReq({ body: Buffer.from('  ') }), empty);
    expect(empty.payload.code).toBe('empty_body');
    const badDry = makeRes();
    await publicPayoutsController.post(makeReq({ body: xmlBody, query: { dry_run: 'yes' } }), badDry);
    expect(badDry.statusCode).toBe(400);
    const ok = makeRes();
    await publicPayoutsController.post(makeReq({ body: xmlBody, query: { dry_run: '1' }, type: 'text/xml' }), ok);
    expect(applyPayoutsApi).toHaveBeenCalledWith({ xml: '<зп_документы_31/>', keyId: 'key-1', dryRun: true });
    expect(ok.payload).toEqual({ success: true, dry_run: true, documents: [{ guid: G, action: 'new' }] });
  });

  it('ошибки сервиса: разбор — 400 invalid_xml, busy — 409 с Retry-After, конфликт — 409 с деталями', async () => {
    applyPayoutsApi.mockRejectedValueOnce(new Payout1cParseError('Документ 1: нет «Док_Номер»'));
    const invalid = makeRes();
    await publicPayoutsController.post(makeReq({ body: xmlBody }), invalid);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.payload).toMatchObject({ code: 'invalid_xml', error: 'Документ 1: нет «Док_Номер»', retryable: false });

    applyPayoutsApi.mockRejectedValueOnce(new PayoutApiError(409, 'busy', 'занято', true));
    const busy = makeRes();
    await publicPayoutsController.post(makeReq({ body: xmlBody }), busy);
    expect(busy.statusCode).toBe(409);
    expect(busy.headers['Retry-After']).toBe('5');
    expect(busy.payload).toMatchObject({ code: 'busy', retryable: true });

    applyPayoutsApi.mockRejectedValueOnce(new PayoutApiError(409, 'duplicate_conflict', 'не приняты', false, [{ index: 0, guid: G, code: 'duplicate_conflict', message: 'итог' }]));
    const conflict = makeRes();
    await publicPayoutsController.post(makeReq({ body: xmlBody }), conflict);
    expect(conflict.payload).toMatchObject({ code: 'duplicate_conflict', retryable: false, errors: [{ guid: G, message: 'итог' }] });
  });

  it('отмена: разбор тела, повтор ГУИДа, ответ', async () => {
    const bad = makeRes();
    await publicPayoutsController.cancel(makeReq({ body: { documents: [{ guid: 'x', version: 1 }] } }), bad);
    expect(bad.payload.code).toBe('invalid_body');
    const dup = makeRes();
    await publicPayoutsController.cancel(makeReq({ body: { documents: [{ guid: G, version: 1 }, { guid: G.toUpperCase(), version: 2 }] } }), dup);
    expect(dup.payload.error).toContain('повторяется');
    const ok = makeRes();
    await publicPayoutsController.cancel(makeReq({ body: { documents: [{ guid: G.toUpperCase(), version: 3 }] } }), ok);
    expect(cancelPayoutsApi).toHaveBeenCalledWith(expect.objectContaining({ items: [{ guid: G, version: 3 }], keyId: 'key-1' }));
    expect(ok.payload).toEqual({ success: true, documents: [{ index: 0, guid: G, version: 3, action: 'cancelled' }] });
  });

  it('тело больше лимита — 413, прочие ошибки — дальше', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    payoutsBodyErrorHandler({ type: 'entity.too.large' }, {} as Request, res, next);
    expect(res.statusCode).toBe(413);
    expect(res.payload.code).toBe('payload_too_large');
    const other = new Error('x');
    payoutsBodyErrorHandler(other, {} as Request, makeRes(), next);
    expect(next).toHaveBeenCalledWith(other);
  });
});
