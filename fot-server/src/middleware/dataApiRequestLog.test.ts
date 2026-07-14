import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const writeRequestLog = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/data-api-key.service.js', () => ({
  dataApiKeyService: {
    writeRequestLog: (...args: unknown[]) => writeRequestLog(...args),
  },
}));

const { dataApiRequestLog } = await import('./dataApiRequestLog.js');

interface IFakeRes {
  statusCode: number;
  locals: Record<string, unknown>;
  finishCallbacks: Array<() => void>;
  on(event: string, cb: () => void): IFakeRes;
  finish(code: number): void;
}

function createFakeRes(): IFakeRes {
  return {
    statusCode: 200,
    locals: {},
    finishCallbacks: [],
    on(event, cb) {
      if (event === 'finish') this.finishCallbacks.push(cb);
      return this;
    },
    finish(code) {
      this.statusCode = code;
      this.finishCallbacks.forEach(cb => cb());
    },
  };
}

function createFakeReq(overrides: Partial<Request> = {}): Request {
  return {
    path: '/timesheet',
    ip: '10.0.0.5',
    query: { month: '2026-07' },
    ...overrides,
  } as unknown as Request;
}

describe('dataApiRequestLog', () => {
  beforeEach(() => {
    writeRequestLog.mockClear();
  });

  it('пишет строку лога с key_id, ресурсом и статусом после finish', () => {
    const req = createFakeReq();
    (req as Request & { dataApiKey?: { id: string } }).dataApiKey = { id: 'key-1' };
    const res = createFakeRes();
    const next = vi.fn() as unknown as NextFunction;

    dataApiRequestLog(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(writeRequestLog).not.toHaveBeenCalled();

    res.finish(200);

    expect(writeRequestLog).toHaveBeenCalledTimes(1);
    const entry = writeRequestLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      key_id: 'key-1',
      table_name: 'timesheet',
      ip: '10.0.0.5',
      status_code: 200,
      query_params: { month: '2026-07' },
      error_message: null,
    });
    expect(entry.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('логирует неаутентифицированный запрос с key_id = null', () => {
    const req = createFakeReq({ query: {} } as Partial<Request>);
    const res = createFakeRes();

    dataApiRequestLog(req, res as unknown as Response, vi.fn() as unknown as NextFunction);
    res.finish(401);

    expect(writeRequestLog).toHaveBeenCalledTimes(1);
    expect(writeRequestLog.mock.calls[0][0]).toMatchObject({
      key_id: null,
      status_code: 401,
      query_params: null,
    });
  });

  it('прокидывает текст ошибки из res.locals.dataApiError', () => {
    const req = createFakeReq();
    const res = createFakeRes();
    res.locals.dataApiError = 'boom';

    dataApiRequestLog(req, res as unknown as Response, vi.fn() as unknown as NextFunction);
    res.finish(500);

    expect(writeRequestLog.mock.calls[0][0]).toMatchObject({
      status_code: 500,
      error_message: 'boom',
    });
  });
});
