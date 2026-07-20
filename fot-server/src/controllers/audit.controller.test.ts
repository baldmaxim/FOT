import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
}));

import { auditController } from './audit.controller.js';
import { query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';

const mockedQuery = vi.mocked(query);

const makeReq = (queryParams: Record<string, unknown>): AuthenticatedRequest =>
  ({ query: queryParams } as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = {
    json: vi.fn(),
    status: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
};

// SQL и параметры первого (основного) запроса
const lastSql = (): string => String(mockedQuery.mock.calls[0][0]);
const lastParams = (): unknown[] => (mockedQuery.mock.calls[0][1] ?? []) as unknown[];

describe('auditController.getActionLogs — поиск q', () => {
  beforeEach(() => {
    mockedQuery.mockClear();
    mockedQuery.mockResolvedValue([]);
  });

  it('q попадает в параметры как %строка%, один плейсхолдер в обоих условиях', async () => {
    const res = makeRes();
    await auditController.getActionLogs(makeReq({ q: 'Ельшина' }), res);

    const sql = lastSql();
    expect(lastParams()).toEqual(['%Ельшина%', 50, 0]);
    expect(sql).toContain('details::text ILIKE $1');
    expect(sql).toContain('full_name ILIKE $1');
    expect(sql).not.toContain('$4');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, total: 0 }));
  });

  it('спецсимволы %, _, \\ экранируются и ищутся буквально', async () => {
    await auditController.getActionLogs(makeReq({ q: '50%_\\' }), makeRes());
    expect(lastParams()[0]).toBe('%50\\%\\_\\\\%');
  });

  it('64 спецсимвола не обрезаются после экранирования', async () => {
    await auditController.getActionLogs(makeReq({ q: '%'.repeat(70) }), makeRes());
    // slice(0,64) до экранирования → 64 × '\%' = 128 символов внутри обёртки
    expect(lastParams()[0]).toBe(`%${'\\%'.repeat(64)}%`);
  });

  it('q объединяется через AND с action и датами', async () => {
    await auditController.getActionLogs(
      makeReq({ q: 'объект', action: 'TIMESHEET_REFRESH', date_from: '2026-07-01', date_to: '2026-07-20' }),
      makeRes(),
    );
    const sql = lastSql();
    expect(sql).toContain('action = $1');
    expect(sql).toContain('details::text ILIKE $2');
    expect(sql).toContain('full_name ILIKE $2');
    expect(sql).toContain('created_at >= $3');
    expect(sql).toContain('created_at <= $4');
    expect(sql).toMatch(/WHERE action = \$1 AND \(details/);
    expect(lastParams()).toEqual([
      'TIMESHEET_REFRESH',
      '%объект%',
      '2026-07-01',
      '2026-07-20T23:59:59.999Z',
      50,
      0,
    ]);
  });

  it('пустая и пробельная строка q не добавляют условие', async () => {
    await auditController.getActionLogs(makeReq({ q: '   ' }), makeRes());
    expect(lastSql()).not.toContain('ILIKE');
    expect(lastParams()).toEqual([50, 0]);
  });

  it('q массивом (?q=a&q=b) не даёт 500 — условие не добавляется', async () => {
    const res = makeRes();
    await auditController.getActionLogs(makeReq({ q: ['a', 'b'] }), res);
    expect(lastSql()).not.toContain('ILIKE');
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
