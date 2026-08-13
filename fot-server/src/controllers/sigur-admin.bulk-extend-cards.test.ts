/**
 * Контроллер массового продления карт: валидация входа, связь с предпросмотром,
 * порядок «подготовка → строгий аудит → запись» и поведение при занятом lock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

const h = vi.hoisted(() => ({
  preview: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  logWithClient: vi.fn(),
  logFromRequest: vi.fn(),
  leaseRelease: vi.fn(),
}));

class LeaseBusyError extends Error {}

vi.mock('../services/sigur-bulk-cards.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/sigur-bulk-cards.service.js')>(
    '../services/sigur-bulk-cards.service.js',
  );
  return {
    ...actual,
    previewBulkExtendCards: h.preview,
    prepareBulkExtendOperation: h.prepare,
    executePreparedBulkExtend: h.execute,
  };
});
vi.mock('../services/sigur-card-lease.service.js', () => ({
  SigurCardLeaseBusyError: LeaseBusyError,
  withSigurCardWriteLease: vi.fn(async (_userId: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: h.withTransaction,
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logWithClient: h.logWithClient, logFromRequest: h.logFromRequest },
}));

const { sigurAdminController } = await import('./sigur-admin.controller.js');
const { createBulkExtendToken } = await import('../services/sigur-bulk-cards-token.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const futureDate = (days: number): string =>
  new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const TARGET_DATE = futureDate(30);
const TARGET_ISO = new Date(`${TARGET_DATE}T23:59:59+03:00`).toISOString();

const makeRes = () => {
  const sent: Record<string, unknown>[] = [];
  const res = {
    statusCode: 200,
    body: null as unknown,
    sent,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      const match = /^data: (.+)\n\n$/.exec(chunk);
      if (match) sent.push(JSON.parse(match[1]));
      return true;
    }),
    end: vi.fn(),
    on: vi.fn(),
  };
  return res as unknown as Response & { statusCode: number; body: any; sent: Record<string, unknown>[] };
};

const makeReq = (over: Record<string, unknown> = {}) => ({
  user: { id: 'user-1' },
  query: {},
  body: {},
  params: {},
  ip: '127.0.0.1',
  get: () => 'vitest',
  ...over,
}) as never;

const validToken = (over: Record<string, unknown> = {}) => createBulkExtendToken({
  employeeIds: [1],
  connection: undefined,
  expirationDate: TARGET_DATE,
  targetIso: TARGET_ISO,
  cards: [{ employeeId: 1, cardId: 100, startDate: null, expirationDate: null, format: 'W26' }],
  ...over,
} as never);

const preparedPlan = {
  lease: { owner: 'op', isLost: () => false, release: h.leaseRelease },
  plan: {
    operationId: 'op',
    expirationDate: TARGET_DATE,
    targetIso: TARGET_ISO,
    employeeIds: [1],
    noCardEmployeeIds: [],
    unreadableEmployeeIds: [],
    items: [],
  },
};

const executeResult = {
  operationId: 'op',
  requestedEmployees: 1,
  updatedEmployees: 1,
  updatedCards: 1,
  retriedCards: 0,
  unknownCards: 0,
  changedDuringWriteCards: 0,
  skippedCards: 0,
  failedCards: 0,
  expiredExtendedCards: 0,
  noCardEmployees: 0,
  unreadableEmployees: 0,
  localUpdatedPasses: 0,
  localSyncFailedPasses: 0,
  localUnknownPasses: 0,
  failedEmployeeIds: [],
  warnings: [],
  items: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({}));
  h.logWithClient.mockResolvedValue(undefined);
  h.prepare.mockResolvedValue(preparedPlan);
  h.execute.mockResolvedValue(executeResult);
  h.preview.mockResolvedValue({
    expirationDate: TARGET_DATE,
    targetIso: TARGET_ISO,
    requestedEmployees: 1,
    willExtendCards: 1,
    expiredCards: 0,
    skippedCards: 0,
    noCardEmployees: 0,
    unreadableEmployees: 0,
    byReason: {},
    cards: [{ employeeId: 1, cardId: 100, startDate: null, expirationDate: null, format: 'W26', expired: false }],
  });
});

describe('previewBulkExtendCards', () => {
  const call = async (query: Record<string, unknown>) => {
    const res = makeRes();
    await sigurAdminController.previewBulkExtendCards(makeReq({ query }), res);
    return res;
  };

  it('возвращает разбор и подписанный previewToken', async () => {
    const res = await call({ employeeIds: '1', expirationDate: TARGET_DATE });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.previewToken).toEqual(expect.any(String));
  });

  it('несуществующая календарная дата → 400', async () => {
    const res = await call({ employeeIds: '1', expirationDate: '2026-02-30' });
    expect(res.statusCode).toBe(400);
  });

  it('сегодняшняя дата → 400: продлевать можно только в будущее', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
    const res = await call({ employeeIds: '1', expirationDate: today });
    expect(res.statusCode).toBe(400);
  });

  it('мусор в списке id не отбрасывается молча → 400', async () => {
    const res = await call({ employeeIds: '1,abc', expirationDate: TARGET_DATE });
    expect(res.statusCode).toBe(400);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it('пустой список → 400', async () => {
    const res = await call({ employeeIds: '', expirationDate: TARGET_DATE });
    expect(res.statusCode).toBe(400);
  });

  it('больше 500 сотрудников → 400', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => index + 1).join(',');
    const res = await call({ employeeIds: ids, expirationDate: TARGET_DATE });
    expect(res.statusCode).toBe(400);
  });

  it('неизвестный контур подключения → 400', async () => {
    const res = await call({ employeeIds: '1', expirationDate: TARGET_DATE, connection: 'prod' });
    expect(res.statusCode).toBe(400);
  });
});

describe('bulkExtendCardsStream', () => {
  const call = async (body: Record<string, unknown>) => {
    const res = makeRes();
    await sigurAdminController.bulkExtendCardsStream(makeReq({ body }), res);
    return res;
  };

  it('отдаёт start → progress → done и пишет пару started/completed', async () => {
    h.execute.mockImplementation(async (_prepared: unknown, send: (event: unknown) => void) => {
      send({ type: 'start', total: 1 });
      send({ type: 'progress', processed: 1, total: 1, employeeId: 1, okCards: 1, failedCards: 0 });
      return executeResult;
    });

    const res = await call({ previewToken: validToken(), confirmExpired: false });

    expect(res.sent.map(event => event.type)).toEqual(['start', 'progress', 'done']);
    const actions = h.logWithClient.mock.calls.map(call => (call[1] as { details: { action: string } }).details.action);
    expect(actions).toEqual(['bulk_extend_cards_started', 'bulk_extend_cards_completed']);
  });

  it('без токена — 400, к Sigur не идём', async () => {
    const res = await call({});

    expect(res.statusCode).toBe(400);
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('подделанный токен — 400', async () => {
    const res = await call({ previewToken: `${validToken()}x` });

    expect(res.statusCode).toBe(400);
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('протухший токен — 400', async () => {
    const stale = createBulkExtendToken({
      employeeIds: [1],
      connection: undefined,
      expirationDate: TARGET_DATE,
      targetIso: TARGET_ISO,
      cards: [],
    } as never, Date.now() - 20 * 60 * 1000);

    const res = await call({ previewToken: stale });

    expect(res.statusCode).toBe(400);
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('занятый lock — 409 без записи', async () => {
    h.prepare.mockRejectedValue(new LeaseBusyError('занято'));

    const res = await call({ previewToken: validToken() });

    expect(res.statusCode).toBe(409);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('сбой started-аудита: запись не начинается, lease отпускается', async () => {
    h.logWithClient.mockRejectedValueOnce(new Error('db down'));

    const res = await call({ previewToken: validToken() });

    expect(res.statusCode).toBe(500);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.leaseRelease).toHaveBeenCalled();
  });

  it('сбой итогового аудита не отменяет выполненное — done с предупреждением', async () => {
    h.logWithClient
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('db down'));

    const res = await call({ previewToken: validToken() });

    const done = res.sent.find(event => event.type === 'done') as { warnings: string[] } | undefined;
    expect(done).toBeDefined();
    expect(done?.warnings.some(warning => warning.includes('журнал'))).toBe(true);
  });

  it('lease отпускается после успешного стрима', async () => {
    await call({ previewToken: validToken() });
    expect(h.leaseRelease).toHaveBeenCalled();
  });
});
