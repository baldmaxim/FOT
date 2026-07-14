import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

// Управление переадресацией ЗА абонента (админка «МТС Бизнес» → «Абоненты»).
// Правила валидации номера назначения — общие с ЛК «Моя SIM»
// (mts-forwarding.shared), разъезжаться они не должны: те же кейсы, что в
// employee-sim.controller.test.ts, но без проверки «номер мой».

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
}));
vi.mock('../services/mts-business-subscribers.service.js', () => ({
  mtsBusinessSubscribersService: {
    listSubscribers: vi.fn(async () => []),
    getSubscriberDetails: vi.fn(async () => null),
  },
}));
vi.mock('../services/mts-business-subscriber-sync.service.js', () => ({ syncSubscriberFull: vi.fn(async () => ({})) }));
vi.mock('../services/mts-business-statement-sync.service.js', () => ({ syncMsisdnStatement: vi.fn(async () => ({})) }));
vi.mock('../services/mts-business-refresh-all.service.js', () => ({ defaultDetalizationWindow: vi.fn(() => ({ from: '2026-07-01', to: '2026-07-14' })) }));
vi.mock('../services/mts-business-statement-rows.service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/mts-business-statement-rows.service.js')>();
  return {
    ...orig,
    mtsBusinessStatementRowsService: {
      getUsageRows: vi.fn(async () => []),
      getUsageTotals: vi.fn(async () => ({ groups: [], total: 0 })),
    },
  };
});
vi.mock('../services/mts-business-mapping.service.js', () => ({
  mtsBusinessMappingService: {
    getSubscriberContext: vi.fn(async () => null),
  },
}));
vi.mock('../services/mts-business-catalog.service.js', () => ({
  mtsBusinessCatalogService: {
    changeCallForwarding: vi.fn(async () => ({ eventId: 'EV-1' })),
  },
}));
vi.mock('../services/mts-business-actions.service.js', () => ({
  mtsBusinessActionsService: { create: vi.fn(async () => undefined) },
}));
vi.mock('../services/mts-business-data.service.js', () => ({ mtsBusinessDataService: {} }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: {
    MTS_BUSINESS_FORWARDING_SET_REQUESTED: 'MTS_BUSINESS_FORWARDING_SET_REQUESTED',
    MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED: 'MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED',
    MTS_BUSINESS_TARIFF_CHANGE_REQUESTED: 'MTS_BUSINESS_TARIFF_CHANGE_REQUESTED',
  },
}));

import { mtsBusinessSubscribersController } from './mts-business-subscribers.controller.js';
import { mtsBusinessCatalogService } from '../services/mts-business-catalog.service.js';
import { mtsBusinessActionsService } from '../services/mts-business-actions.service.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const catalog = vi.mocked(mtsBusinessCatalogService);
const actions = vi.mocked(mtsBusinessActionsService);
const audit = vi.mocked(auditService);

const ACCOUNT = 'a1b2c3d4-0000-0000-0000-000000000001';
const MSISDN = '79151204230';

const mockReq = (body: Record<string, unknown>): AuthenticatedRequest =>
  ({ user: { id: 'u-1', employee_id: 1 }, body, query: {}, params: {} } as unknown as AuthenticatedRequest);

const mockRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};

describe('МТС Бизнес «Абоненты»: переадресация за абонента', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalog.changeCallForwarding.mockResolvedValue({ eventId: 'EV-1' });
  });

  it('включает CFNRY: дефолтный таймер 20 сек, заявка и аудит с хвостом номера', async () => {
    const res = mockRes();
    await mtsBusinessSubscribersController.setForwarding(
      mockReq({ accountId: ACCOUNT, msisdn: MSISDN, type: 'CFNRY', target: '+7 916 555-11-22', confirmed: true }),
      res,
    );

    expect(catalog.changeCallForwarding).toHaveBeenCalledWith(ACCOUNT, MSISDN, 'create', {
      forwardingType: 'CFNRY',
      forwardingAddress: '79165551122',
      noReplyTimer: 20,
      numType: 'Regular',
    });
    expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'EV-1', actionType: 'forwarding_set', scope: 'msisdn', msisdn: MSISDN,
    }));
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'u-1', 'MTS_BUSINESS_FORWARDING_SET_REQUESTED',
      { details: { accountId: ACCOUNT, type: 'CFNRY', timer: 20, targetTail: '1122' } },
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { eventId: 'EV-1' } });
  });

  it('CFU без таймера — noReplyTimer не уходит в МТС', async () => {
    await mtsBusinessSubscribersController.setForwarding(
      mockReq({ accountId: ACCOUNT, msisdn: MSISDN, type: 'CFU', target: '79165551122', timer: 25, confirmed: true }),
      mockRes(),
    );
    expect(catalog.changeCallForwarding).toHaveBeenCalledWith(
      ACCOUNT, MSISDN, 'create', expect.objectContaining({ forwardingType: 'CFU', noReplyTimer: undefined }),
    );
  });

  it('переадресация на 8-800 → 400, вызова МТС нет', async () => {
    const res = mockRes();
    await mtsBusinessSubscribersController.setForwarding(
      mockReq({ accountId: ACCOUNT, msisdn: MSISDN, type: 'CFU', target: '88005553535', confirmed: true }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(catalog.changeCallForwarding).not.toHaveBeenCalled();
  });

  it('переадресация номера на самого себя → 400', async () => {
    const res = mockRes();
    await mtsBusinessSubscribersController.setForwarding(
      mockReq({ accountId: ACCOUNT, msisdn: MSISDN, type: 'CFU', target: MSISDN, confirmed: true }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(catalog.changeCallForwarding).not.toHaveBeenCalled();
  });

  it('без confirmed=true → 400 (защита от случайного вызова)', async () => {
    const res = mockRes();
    await mtsBusinessSubscribersController.setForwarding(
      mockReq({ accountId: ACCOUNT, msisdn: MSISDN, type: 'CFU', target: '79165551122' }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(catalog.changeCallForwarding).not.toHaveBeenCalled();
  });

  it('снятие правила: action=delete, заявка forwarding_remove', async () => {
    const res = mockRes();
    catalog.changeCallForwarding.mockResolvedValue({ eventId: 'EV-2' });

    await mtsBusinessSubscribersController.deleteForwarding(
      mockReq({ accountId: ACCOUNT, msisdn: MSISDN, type: 'CFU', confirmed: true }),
      res,
    );

    expect(catalog.changeCallForwarding).toHaveBeenCalledWith(ACCOUNT, MSISDN, 'delete', {
      forwardingType: 'CFU', numType: 'Regular',
    });
    expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'EV-2', actionType: 'forwarding_remove',
    }));
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { eventId: 'EV-2' } });
  });

  it('неизвестный тип правила (CFB вне MVP) → 400', async () => {
    const res = mockRes();
    await mtsBusinessSubscribersController.deleteForwarding(
      mockReq({ accountId: ACCOUNT, msisdn: MSISDN, type: 'CFB', confirmed: true }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(catalog.changeCallForwarding).not.toHaveBeenCalled();
  });
});
