import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Окно подачи табеля. Роли с timesheet_show_full_period (а это все роли) и HR раньше
 * обходили гард целиком и могли подать «Весь месяц» в середине месяца — замок закрывал
 * ещё не сданную вторую половину. Теперь им разрешены только завершённые полупериоды,
 * выровненные по границам 1/16 и 15/последний день.
 */

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({ pgQuery: vi.fn(), pgQueryOne: vi.fn() }));
vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: pgQueryOne,
}));

vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async () => false),
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: {},
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/notification.service.js', () => ({
  notificationService: { createMany: vi.fn(async () => undefined) },
}));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendToUsers: vi.fn(async () => undefined) },
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { timesheetApprovalController } from './timesheet-approval.controller.js';

const DEPT = '3ad4aa9f-d988-4c49-bc52-abb74ef74bd9';

const makeRes = () => {
  const res = { _status: 200, _json: undefined as unknown } as {
    _status: number; _json: unknown; status: (c: number) => unknown; json: (p: unknown) => unknown;
  };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (payload: unknown) => { res._json = payload; return res; };
  return res as unknown as { _status: number; _json: unknown } & Parameters<
    typeof timesheetApprovalController.submit
  >[1];
};

const makeReq = (startDate: string, endDate: string): AuthenticatedRequest => ({
  params: {},
  query: {},
  body: { department_id: DEPT, start_date: startDate, end_date: endDate },
  user: {
    id: 'user-uuid', employee_id: 8783, is_admin: false,
    role_code: 'manager', timesheet_show_full_period: true,
  },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  pgQuery.mockReset();
  pgQueryOne.mockReset();
  pgQuery.mockResolvedValue([]);
  pgQueryOne.mockResolvedValue(null);
  // Сегодня 20.08.2026 (МСК): последний завершённый период — 01–15 августа.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-20T12:00:00+03:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

const body = (res: { _json: unknown }) => res._json as { success: boolean; code?: string };

describe('timesheet-approval.submit — окно подачи для exempt-роли', () => {
  it('отклоняет «весь месяц» текущего месяца', async () => {
    const res = makeRes();
    await timesheetApprovalController.submit(makeReq('2026-08-01', '2026-08-31'), res);

    expect(res._status).toBe(409);
    expect(body(res).code).toBe('SUBMISSION_PERIOD_LOCKED');
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('отклоняет ещё не завершённую вторую половину', async () => {
    const res = makeRes();
    await timesheetApprovalController.submit(makeReq('2026-08-16', '2026-08-31'), res);

    expect(res._status).toBe(409);
    expect(body(res).code).toBe('SUBMISSION_PERIOD_LOCKED');
  });

  it('отклоняет невыровненный диапазон внутри завершённого месяца', async () => {
    const res = makeRes();
    await timesheetApprovalController.submit(makeReq('2026-07-05', '2026-07-20'), res);

    expect(res._status).toBe(409);
    expect(body(res).code).toBe('SUBMISSION_PERIOD_LOCKED');
  });

  it('пропускает гард для завершённого прошлого месяца целиком', async () => {
    const res = makeRes();
    await timesheetApprovalController.submit(makeReq('2026-07-01', '2026-07-31'), res);

    expect(body(res).code).not.toBe('SUBMISSION_PERIOD_LOCKED');
    // Гард пройден — контроллер дошёл до выборки пересекающихся подач.
    expect(pgQuery).toHaveBeenCalled();
  });
});
