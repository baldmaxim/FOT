import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Ведомости выплаты по API через настоящий публичный роутер, смонтированный как в app.ts (глобальные json/urlencoded
 * до него): XML с кириллицей доходит до сервиса той же строкой (express.raw), больше 25 МБ — JSON 413, JSON отмены
 * разбирается, без ключа — 401. Ключ и сервис записи — заглушки (запись проверяет payroll-1c-payouts.api.pg.test.ts).
 */

const h = vi.hoisted(() => ({
  applyPayoutsApi: vi.fn(),
  cancelPayoutsApi: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
}));
vi.mock('../services/data-api-key.service.js', () => ({
  dataApiKeyService: {
    authenticateRawToken: vi.fn(async (token: string) => (token === 'good'
      ? { ok: true, key: { id: 'key-1', name: 'api_1C', rate_limit_per_minute: 300, allow_payroll_payouts_import: true } }
      : { ok: false, detail: 'Invalid token' })),
    writeRequestLog: vi.fn(async () => undefined),
  },
}));
vi.mock('../services/payroll/payroll-1c-payouts.api.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/payroll/payroll-1c-payouts.api.service.js')>()),
  applyPayoutsApi: h.applyPayoutsApi,
  cancelPayoutsApi: h.cancelPayoutsApi,
}));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/api/public/v1', (await import('../routes/public-data-api.routes.js')).default);

const G = '11111111-1111-4111-8111-111111111111';
const XML = '<?xml version="1.0" encoding="UTF-8"?><зп_документы_31><имя>Ведомость «Аванс» — Гобова</имя></зп_документы_31>';

describe('POST /api/public/v1/payroll/payouts — через роутер', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.applyPayoutsApi.mockResolvedValue([{ guid: G, action: 'new' }]);
    h.cancelPayoutsApi.mockResolvedValue([{ index: 0, guid: G, version: 2, action: 'cancelled' }]);
  });

  it('XML с кириллицей доходит той же строкой; dry_run', async () => {
    const res = await request(app)
      .post('/api/public/v1/payroll/payouts?dry_run=1')
      .set('Authorization', 'Bearer good')
      .set('Content-Type', 'application/xml; charset=utf-8')
      .send(XML);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, dry_run: true, documents: [{ guid: G, action: 'new' }] });
    expect(h.applyPayoutsApi).toHaveBeenCalledWith({ xml: XML, keyId: 'key-1', dryRun: true });
  });

  it('без ключа — 401, не XML — 415, больше 25 МБ — JSON 413; сервис не вызывается', async () => {
    expect((await request(app).post('/api/public/v1/payroll/payouts').set('Content-Type', 'application/xml').send(XML)).status)
      .toBe(401);
    const json = await request(app).post('/api/public/v1/payroll/payouts').set('Authorization', 'Bearer good').send({ a: 1 });
    expect(json.status).toBe(415);
    const big = await request(app)
      .post('/api/public/v1/payroll/payouts')
      .set('Authorization', 'Bearer good')
      .set('Content-Type', 'application/xml')
      .send(`<a>${'я'.repeat(13 * 1024 * 1024)}</a>`);
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ success: false, code: 'payload_too_large', retryable: false });
    expect(h.applyPayoutsApi).not.toHaveBeenCalled();
  });

  it('отмена — JSON разбирается, ГУИД в нижнем регистре', async () => {
    const res = await request(app)
      .post('/api/public/v1/payroll/payouts/cancel')
      .set('Authorization', 'Bearer good')
      .send({ documents: [{ guid: G.toUpperCase(), version: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([{ index: 0, guid: G, version: 2, action: 'cancelled' }]);
    expect(h.cancelPayoutsApi).toHaveBeenCalledWith(expect.objectContaining({ items: [{ guid: G, version: 2 }], keyId: 'key-1' }));
  });
});
