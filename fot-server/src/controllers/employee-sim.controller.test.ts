import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
}));
vi.mock('../services/mts-business-mapping.service.js', () => ({
  mtsBusinessMappingService: {
    getMsisdnsByEmployeeId: vi.fn(async () => []),
    getPhonebook: vi.fn(async () => []),
    getNamesByMsisdnHash: vi.fn(async () => new Map()),
  },
}));
vi.mock('../services/mts-business-subscribers.service.js', () => ({
  mtsBusinessSubscribersService: {
    getMySimSummary: vi.fn(async () => null),
  },
}));
vi.mock('../services/mts-business-statement-rows.service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/mts-business-statement-rows.service.js')>();
  return {
    ...orig, // parseUsagePeriod — настоящая чистая функция
    mtsBusinessStatementRowsService: {
      getUsageRows: vi.fn(async () => []),
      getDailyStats: vi.fn(async () => []),
      getMonthsWithData: vi.fn(async () => []),
      storeRows: vi.fn(async () => ({ inserted: 0, skipped: 0, noDate: 0 })),
    },
  };
});

import { employeeSimController } from './employee-sim.controller.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { mtsBusinessSubscribersService } from '../services/mts-business-subscribers.service.js';
import { mtsBusinessStatementRowsService } from '../services/mts-business-statement-rows.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const mapping = vi.mocked(mtsBusinessMappingService);
const subscribers = vi.mocked(mtsBusinessSubscribersService);
const stmtRows = vi.mocked(mtsBusinessStatementRowsService);

const mockReq = (employeeId: number | null, query: Record<string, string> = {}): AuthenticatedRequest =>
  ({ user: { employee_id: employeeId }, query, params: {} } as unknown as AuthenticatedRequest);

const mockRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('employeeSimController.getMyNumbers', () => {
  it('нет employee_id → пустой список, БД не трогаем', async () => {
    const res = mockRes();
    await employeeSimController.getMyNumbers(mockReq(null), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { numbers: [] } });
    expect(mapping.getMsisdnsByEmployeeId).not.toHaveBeenCalled();
  });

  it('номера резолвятся ТОЛЬКО по employee_id из JWT', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce(['79150000001']);
    const res = mockRes();
    await employeeSimController.getMyNumbers(mockReq(42), res);
    expect(mapping.getMsisdnsByEmployeeId).toHaveBeenCalledWith(42);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { numbers: ['79150000001'] } });
  });
});

describe('employeeSimController.getMySim', () => {
  it('ответ не содержит ПДн и баланса ЛС (полей нет в принципе)', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce(['79150000001']);
    subscribers.getMySimSummary.mockResolvedValueOnce({
      msisdn: '79150000001',
      tariff: { name: 'Умный бизнес', fee: { amount: 750, currencyCode: 'RUB' } },
      services: [],
      blocks: [],
      packages: [],
      charges: { amount: 123.45, capturedAt: '2026-07-13' },
      capturedAt: '2026-07-13',
    });
    stmtRows.getMonthsWithData.mockResolvedValueOnce(['2026-07']);
    const res = mockRes();
    await employeeSimController.getMySim(mockReq(42), res);

    const payload = res.json.mock.calls[0][0] as { data: { numbers: Array<Record<string, unknown>> } };
    expect(payload.data.numbers).toHaveLength(1);
    const sim = payload.data.numbers[0];
    expect(sim.months).toEqual(['2026-07']);
    expect(sim).not.toHaveProperty('personalData');
    expect(sim).not.toHaveProperty('balance');
    expect(sim).not.toHaveProperty('payments');
  });

  it('SIM не привязана → numbers: []', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([]);
    const res = mockRes();
    await employeeSimController.getMySim(mockReq(42), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { numbers: [] } });
  });
});

describe('employeeSimController.getMyUsage', () => {
  it('без month/date → 400', async () => {
    const res = mockRes();
    await employeeSimController.getMyUsage(mockReq(42), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('peerName резолвится по peer_hash, сам peerHash наружу не уходит; total из дневных агрегатов', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce(['79150000001']);
    mapping.getNamesByMsisdnHash.mockResolvedValueOnce(new Map([['PEER_HASH', 'Иванов Иван']]));
    stmtRows.getUsageRows.mockResolvedValueOnce([{
      date: '2026-07-06T10:00:00.000Z', category: 'calls', label: null, networkEvent: 'call',
      direction: 'out', peer: '79151234567', units: 60, unitCode: 'SECOND', amount: 0, peerHash: 'PEER_HASH',
    }]);
    stmtRows.getDailyStats.mockResolvedValueOnce([
      { date: '2026-07-06', events: 1, calls: 1, callsSeconds: 60, smsCount: 0, internetBytes: 0, amount: 12.5 },
      { date: '2026-07-07', events: 2, calls: 0, callsSeconds: 0, smsCount: 2, internetBytes: 0, amount: 4.5 },
    ]);
    const res = mockRes();
    await employeeSimController.getMyUsage(mockReq(42, { month: '2026-07' }), res);

    expect(stmtRows.getUsageRows).toHaveBeenCalledWith(expect.any(String), '2026-07-01', '2026-07-31');
    const payload = res.json.mock.calls[0][0] as {
      data: { month: string; numbers: Array<{ rows: Array<Record<string, unknown>>; total: number }> };
    };
    expect(payload.data.month).toBe('2026-07');
    const num = payload.data.numbers[0];
    expect(num.rows[0].peerName).toBe('Иванов Иван');
    expect(num.rows[0]).not.toHaveProperty('peerHash');
    expect(num.total).toBe(17);
  });

  it('нет employee_id → пустой ответ без обращений к данным', async () => {
    const res = mockRes();
    await employeeSimController.getMyUsage(mockReq(null, { month: '2026-07' }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { month: '2026-07', numbers: [] } });
    expect(stmtRows.getUsageRows).not.toHaveBeenCalled();
  });
});

describe('employeeSimController.getPhonebook', () => {
  it('отдаёт строки телефонной книги как есть (номер/ФИО/должность/отдел)', async () => {
    mapping.getPhonebook.mockResolvedValueOnce([
      { msisdn: '79150000001', employeeId: 1, fullName: 'Иванов Иван', positionName: 'Инженер', departmentName: 'ПТО' },
    ]);
    const res = mockRes();
    await employeeSimController.getPhonebook(mockReq(null), res);
    const payload = res.json.mock.calls[0][0] as { data: { rows: Array<Record<string, unknown>> } };
    expect(payload.data.rows[0].fullName).toBe('Иванов Иван');
    expect(payload.data.rows[0]).not.toHaveProperty('mtsFio');
    expect(payload.data.rows[0]).not.toHaveProperty('pdStatus');
  });
});
