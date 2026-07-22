import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    getSubscriberContext: vi.fn(async () => null),
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
      getUsageTotals: vi.fn(async () => ({ groups: [], total: 0 })),
      getMonthsWithData: vi.fn(async () => []),
      storeRows: vi.fn(async () => ({ inserted: 0, skipped: 0, noDate: 0 })),
    },
  };
});

vi.mock('../services/mts-business-metrics-store.service.js', () => ({
  mtsBusinessMetricsStoreService: {
    getLatestSnapshotForMsisdn: vi.fn(async () => null),
    upsertSnapshot: vi.fn(async () => undefined),
  },
}));
vi.mock('../services/mts-business-catalog.service.js', () => ({
  mtsBusinessCatalogService: {
    changeCallForwarding: vi.fn(async () => ({ outcome: 'queued', eventId: 'EV-1' })),
  },
}));
vi.mock('../services/mts-business-actions.service.js', () => ({
  mtsBusinessActionsService: {
    create: vi.fn(async () => undefined),
    getByEventId: vi.fn(async () => null),
  },
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: {
    MTS_BUSINESS_FORWARDING_SET_REQUESTED: 'MTS_BUSINESS_FORWARDING_SET_REQUESTED',
    MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED: 'MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED',
  },
}));

import { employeeSimController } from './employee-sim.controller.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { mtsBusinessSubscribersService } from '../services/mts-business-subscribers.service.js';
import { mtsBusinessStatementRowsService } from '../services/mts-business-statement-rows.service.js';
import { mtsBusinessCatalogService } from '../services/mts-business-catalog.service.js';
import { mtsBusinessActionsService } from '../services/mts-business-actions.service.js';
import { mtsBusinessMetricsStoreService } from '../services/mts-business-metrics-store.service.js';
import { auditService } from '../services/audit.service.js';
import { MtsBusinessApiError } from '../services/mts-business-base.service.js';
import { msisdnHash } from '../services/mts-business-cdr.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const mapping = vi.mocked(mtsBusinessMappingService);
const subscribers = vi.mocked(mtsBusinessSubscribersService);
const stmtRows = vi.mocked(mtsBusinessStatementRowsService);
const catalog = vi.mocked(mtsBusinessCatalogService);
const actions = vi.mocked(mtsBusinessActionsService);
const metrics = vi.mocked(mtsBusinessMetricsStoreService);
const audit = vi.mocked(auditService);

const mockReq = (employeeId: number | null, query: Record<string, string> = {}): AuthenticatedRequest =>
  ({ user: { id: 'u-1', employee_id: employeeId }, query, params: {} } as unknown as AuthenticatedRequest);

const mockReqBody = (employeeId: number | null, body: Record<string, unknown>): AuthenticatedRequest =>
  ({ user: { id: 'u-1', employee_id: employeeId }, body, query: {}, params: {} } as unknown as AuthenticatedRequest);

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
    expect(sim).not.toHaveProperty('services');
    expect(sim).not.toHaveProperty('blocks');
  });

  it('SIM не привязана → numbers: []', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([]);
    const res = mockRes();
    await employeeSimController.getMySim(mockReq(42), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { numbers: [] } });
  });
});

describe('employeeSimController.getMySim — псевдо-пакет «Интернет»', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T12:00:00+03:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const minutesPackage = {
    name: 'Ежемесячная плата Умный бизнес M (мин)',
    unitOfMeasure: 'SECOND',
    quota: 60000,
    remainder: 32340,
    consumption: null,
    rotate: null,
    validFrom: '2026-06-16T21:00:00Z',
    validTo: '2026-07-16T20:59:59Z',
  };

  it('нет BYTE-счётчика → добавляется «Интернет» 30 ГБ минус трафик за биллинг-период номера', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce(['79150000001']);
    subscribers.getMySimSummary.mockResolvedValueOnce({
      msisdn: '79150000001',
      tariff: { name: 'Умный бизнес M', fee: null },
      charges: null,
      packages: [minutesPackage],
      capturedAt: '2026-07-10',
    });
    stmtRows.getMonthsWithData.mockResolvedValueOnce(['2026-07']);
    stmtRows.getUsageTotals.mockResolvedValueOnce({
      groups: [{ key: 'internet', count: 10, seconds: 0, bytes: 5_000_000_000, amount: 0, inCount: 0, inSeconds: 0, outCount: 0, outSeconds: 0 }],
      total: 0,
    });
    const res = mockRes();
    await employeeSimController.getMySim(mockReq(42), res);

    // Период трафика = биллинг-цикл номера (validFrom тарифного пакета по МСК) → сегодня.
    expect(stmtRows.getUsageTotals).toHaveBeenCalledWith(expect.any(String), '2026-06-17', '2026-07-10');
    const payload = res.json.mock.calls[0][0] as {
      data: { numbers: Array<{ packages: Array<{ name: string | null; unitOfMeasure: string | null; quota: number | null; remainder: number | null }> }> };
    };
    const internet = payload.data.numbers[0].packages.find(p => p.unitOfMeasure === 'BYTE');
    expect(internet).toBeDefined();
    expect(internet?.name).toBe('Интернет');
    expect(internet?.quota).toBe(30_000_000_000);
    expect(internet?.remainder).toBe(25_000_000_000);
  });

  it('BYTE-счётчик с остатком уже есть → псевдо-пакет не добавляется, выписка не читается', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce(['79150000001']);
    subscribers.getMySimSummary.mockResolvedValueOnce({
      msisdn: '79150000001',
      tariff: { name: 'Умный бизнес M', fee: null },
      charges: null,
      packages: [{ ...minutesPackage, name: 'Интернет-пакет 300', unitOfMeasure: 'BYTE', quota: null, remainder: 200_000_000 }],
      capturedAt: '2026-07-10',
    });
    stmtRows.getMonthsWithData.mockResolvedValueOnce(['2026-07']);
    const res = mockRes();
    await employeeSimController.getMySim(mockReq(42), res);

    expect(stmtRows.getUsageTotals).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as {
      data: { numbers: Array<{ packages: Array<{ unitOfMeasure: string | null }> }> };
    };
    expect(payload.data.numbers[0].packages.filter(p => p.unitOfMeasure === 'BYTE')).toHaveLength(1);
  });

  it('трафик превысил квоту → остаток 0, не отрицательный', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce(['79150000001']);
    subscribers.getMySimSummary.mockResolvedValueOnce({
      msisdn: '79150000001',
      tariff: { name: 'Умный бизнес M', fee: null },
      charges: null,
      packages: [minutesPackage],
      capturedAt: '2026-07-10',
    });
    stmtRows.getMonthsWithData.mockResolvedValueOnce(['2026-07']);
    stmtRows.getUsageTotals.mockResolvedValueOnce({
      groups: [{ key: 'internet', count: 10, seconds: 0, bytes: 31_000_000_000, amount: 0, inCount: 0, inSeconds: 0, outCount: 0, outSeconds: 0 }],
      total: 0,
    });
    const res = mockRes();
    await employeeSimController.getMySim(mockReq(42), res);

    const payload = res.json.mock.calls[0][0] as {
      data: { numbers: Array<{ packages: Array<{ unitOfMeasure: string | null; remainder: number | null }> }> };
    };
    expect(payload.data.numbers[0].packages.find(p => p.unitOfMeasure === 'BYTE')?.remainder).toBe(0);
  });
});

describe('employeeSimController.getMyUsage', () => {
  it('без month/date → 400', async () => {
    const res = mockRes();
    await employeeSimController.getMyUsage(mockReq(42), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('peerName резолвится по peer_hash, сам peerHash наружу не уходит; total и плитки — из SQL-агрегата', async () => {
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
    // Итог берётся из getUsageTotals, а НЕ из суммы отданных строк: строки
    // капятся лимитом, агрегат — нет (ЛК и админка обязаны показывать одно число).
    stmtRows.getUsageTotals.mockResolvedValueOnce({
      groups: [
        { key: 'calls', count: 1, seconds: 60, bytes: 0, amount: 12.5, inCount: 0, inSeconds: 0, outCount: 1, outSeconds: 60 },
        { key: 'sms', count: 2, seconds: 0, bytes: 0, amount: 4.5, inCount: 0, inSeconds: 0, outCount: 0, outSeconds: 0 },
      ],
      total: 17,
    });
    const res = mockRes();
    await employeeSimController.getMyUsage(mockReq(42, { month: '2026-07' }), res);

    expect(stmtRows.getUsageRows).toHaveBeenCalledWith(expect.any(String), '2026-07-01', '2026-07-31');
    expect(stmtRows.getUsageTotals).toHaveBeenCalledWith(expect.any(String), '2026-07-01', '2026-07-31');
    const payload = res.json.mock.calls[0][0] as {
      data: {
        month: string;
        numbers: Array<{
          rows: Array<Record<string, unknown>>;
          total: number;
          totals: { groups: Array<{ key: string; count: number }>; total: number };
        }>;
      };
    };
    expect(payload.data.month).toBe('2026-07');
    const num = payload.data.numbers[0];
    expect(num.rows[0].peerName).toBe('Иванов Иван');
    expect(num.rows[0]).not.toHaveProperty('peerHash');
    expect(num.total).toBe(17);
    expect(num.totals.groups.find(g => g.key === 'sms')?.count).toBe(2);
  });

  it('нет employee_id → пустой ответ без обращений к данным', async () => {
    const res = mockRes();
    await employeeSimController.getMyUsage(mockReq(null, { month: '2026-07' }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { month: '2026-07', numbers: [] } });
    expect(stmtRows.getUsageRows).not.toHaveBeenCalled();
  });
});

describe('employeeSimController — переадресация', () => {
  const OWN = '79150000001';

  it('setMyForwarding: чужой номер → 403, вызова в МТС нет', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    const res = mockRes();
    await employeeSimController.setMyForwarding(
      mockReqBody(42, { msisdn: '79159999999', type: 'CFU', target: '79161234567' }), res,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(catalog.changeCallForwarding).not.toHaveBeenCalled();
  });

  it('setMyForwarding: переадресация на свой же номер → 400', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    const res = mockRes();
    await employeeSimController.setMyForwarding(mockReqBody(42, { type: 'CFU', target: '89150000001' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(catalog.changeCallForwarding).not.toHaveBeenCalled();
  });

  it('setMyForwarding: платный/сервисный номер (8-800) → 400', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    const res = mockRes();
    await employeeSimController.setMyForwarding(mockReqBody(42, { type: 'CFU', target: '88001234567' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(catalog.changeCallForwarding).not.toHaveBeenCalled();
  });

  it('setMyForwarding: короткий номер → 400', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    const res = mockRes();
    await employeeSimController.setMyForwarding(mockReqBody(42, { type: 'CFU', target: '0890' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('setMyForwarding: happy-path — вызов МТС, заявка и аудит; CFNRY без таймера → дефолт 20 сек', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    mapping.getSubscriberContext.mockResolvedValueOnce({ accountId: 'acc-1' } as never);
    const res = mockRes();
    await employeeSimController.setMyForwarding(
      mockReqBody(42, { msisdn: OWN, type: 'CFNRY', target: '+7 (916) 123-45-67' }), res,
    );

    expect(catalog.changeCallForwarding).toHaveBeenCalledWith('acc-1', OWN, 'create', {
      forwardingType: 'CFNRY', forwardingAddress: '79161234567', noReplyTimer: 20,
    });
    expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'EV-1', actionType: 'forwarding_set', scope: 'msisdn', msisdn: OWN, requestedBy: 'u-1',
    }));
    expect(audit.logFromRequest).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { outcome: 'queued', eventId: 'EV-1', tracking: true } });
  });

  it('setMyForwarding: applied — заявки нет, снапшот из прочитанных правил', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    mapping.getSubscriberContext.mockResolvedValueOnce({ accountId: 'acc-1' } as never);
    const rules = [{ forwardingType: 'CFU', forwardingAddress: '79161234567', noReplyTimer: null, numType: 'Regular', status: null }];
    catalog.changeCallForwarding.mockResolvedValueOnce({ outcome: 'applied', eventId: null, rules });
    const res = mockRes();

    await employeeSimController.setMyForwarding(mockReqBody(42, { msisdn: OWN, type: 'CFU', target: '79161234567' }), res);

    expect(actions.create).not.toHaveBeenCalled();
    expect(metrics.upsertSnapshot).toHaveBeenCalledWith({
      accountId: 'acc-1', scope: 'msisdn', msisdn: OWN, metric: 'forwarding', payload: rules,
    });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { outcome: 'applied', eventId: null, tracking: true } });
  });

  it('setMyForwarding: падение аудита не отменяет успех МТС (tracking:false, не 500)', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    mapping.getSubscriberContext.mockResolvedValueOnce({ accountId: 'acc-1' } as never);
    audit.logFromRequest.mockRejectedValueOnce(new Error('audit down'));
    const res = mockRes();

    await employeeSimController.setMyForwarding(mockReqBody(42, { msisdn: OWN, type: 'CFU', target: '79161234567' }), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { outcome: 'queued', eventId: 'EV-1', tracking: false } });
  });

  it('setMyForwarding: unknown → 202, ничего локально не пишем', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    mapping.getSubscriberContext.mockResolvedValueOnce({ accountId: 'acc-1' } as never);
    catalog.changeCallForwarding.mockResolvedValueOnce({ outcome: 'unknown', eventId: null });
    const res = mockRes();

    await employeeSimController.setMyForwarding(mockReqBody(42, { msisdn: OWN, type: 'CFU', target: '79161234567' }), res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(actions.create).not.toHaveBeenCalled();
    expect(metrics.upsertSnapshot).not.toHaveBeenCalled();
  });

  it('setMyForwarding: ошибка МТС отдаётся сотруднику текстом оператора (502 + mtsMessage)', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    mapping.getSubscriberContext.mockResolvedValueOnce({ accountId: 'acc-1' } as never);
    catalog.changeCallForwarding.mockRejectedValueOnce(new MtsBusinessApiError('Переадресация недоступна на тарифе', 400, '2005'));
    const res = mockRes();

    await employeeSimController.setMyForwarding(mockReqBody(42, { msisdn: OWN, type: 'CFU', target: '79161234567' }), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ mtsMessage: 'Переадресация недоступна на тарифе' }));
  });

  it('deleteMyForwarding: снимает правило действием delete', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    mapping.getSubscriberContext.mockResolvedValueOnce({ accountId: 'acc-1' } as never);
    const res = mockRes();
    await employeeSimController.deleteMyForwarding(mockReqBody(42, { msisdn: OWN, type: 'CFU' }), res);

    expect(catalog.changeCallForwarding).toHaveBeenCalledWith('acc-1', OWN, 'delete', {
      forwardingType: 'CFU',
    });
    expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'forwarding_remove' }));
  });

  it('getMyForwarding: правило берётся из снапшота, живых вызовов МТС нет', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    metrics.getLatestSnapshotForMsisdn.mockResolvedValueOnce({
      payload: [{ forwardingType: 'CFU', forwardingAddress: '79161234567', noReplyTimer: null, numType: 'Regular', status: 'active' }],
      capturedAt: '2026-07-13T23:10:00.000Z',
    });
    const res = mockRes();
    await employeeSimController.getMyForwarding(mockReq(42), res);

    const payload = res.json.mock.calls[0][0] as { data: { numbers: Array<{ rules: unknown[] }> } };
    expect(payload.data.numbers[0].rules).toHaveLength(1);
    expect(catalog.changeCallForwarding).not.toHaveBeenCalled();
  });

  it('getMyForwardingStatus: чужая заявка → 404, статус не раскрываем', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    actions.getByEventId.mockResolvedValueOnce({
      eventId: 'EV-9', status: 'completed', msisdnHash: 'ЧУЖОЙ_ХЭШ', actionType: 'forwarding_set', requestedBy: 'u-2',
    });
    const res = mockRes();
    await employeeSimController.getMyForwardingStatus(mockReq(42, { eventId: 'EV-9' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('getMyForwardingStatus: своя заявка → статус отдаётся', async () => {
    mapping.getMsisdnsByEmployeeId.mockResolvedValueOnce([OWN]);
    actions.getByEventId.mockResolvedValueOnce({
      eventId: 'EV-1', status: 'in_progress', msisdnHash: msisdnHash(OWN), actionType: 'forwarding_set', requestedBy: 'u-1',
    });
    const res = mockRes();
    await employeeSimController.getMyForwardingStatus(mockReq(42, { eventId: 'EV-1' }), res);
    const payload = res.json.mock.calls[0][0] as { data: { status: string } };
    expect(payload.data.status).toBe('in_progress');
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
