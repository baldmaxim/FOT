import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const svc = vi.hoisted(() => ({ getStay: vi.fn(), getEmployeeState: vi.fn() }));
vi.mock('../services/dormitory-stays.service.js', () => svc);

const pauseSvc = vi.hoisted(() => ({
  suspendCompensation: vi.fn(),
  resumeCompensation: vi.fn(),
  finishCompensationPause: vi.fn(),
}));
vi.mock('../services/dormitory-compensation-pause.service.js', () => pauseSvc);

const access = vi.hoisted(() => ({ canWriteStay: vi.fn() }));
vi.mock('./dormitory-access.js', () => access);

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { dormitoryCompensationPauseController as c } from './dormitory-compensation-pause.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest => ({
  user: { id: 'user-1' }, params: { id: '8' }, query: {}, body: {}, ...over,
} as unknown as AuthenticatedRequest);

const COMP = {
  id: 8, employee_id: 43, full_name: 'Кесаев Станислав Игоревич', kind: 'apartment', check_in: '2026-09-01',
  check_out: null, address: null, amount: '630.00', apartment_id: null, paid: false, comment: null,
  suspended: false, resumed_from_id: null,
};
const PAUSED = { ...COMP, check_out: '2026-11-16', suspended: true };
const RESUMED = { ...COMP, id: 9, check_in: '2026-12-01', resumed_from_id: 8 };

beforeEach(() => {
  vi.clearAllMocks();
  svc.getStay.mockResolvedValue(COMP);
  access.canWriteStay.mockResolvedValue(true);
});

describe('«Компенсация аренды»: пауза и возобновление (374)', () => {
  it('приостановить: дата обязательна; запись и аудит «было → стало» с action', async () => {
    let res = makeRes();
    await c.suspend(makeReq({ body: { date: '2026-02-30' } }), res);
    expect(res.statusCode).toBe(400);
    expect(pauseSvc.suspendCompensation).not.toHaveBeenCalled();

    pauseSvc.suspendCompensation.mockResolvedValue({ before: COMP, after: PAUSED, repeated: false });
    res = makeRes();
    await c.suspend(makeReq({ body: { date: '2026-11-16' } }), res);
    expect(pauseSvc.suspendCompensation).toHaveBeenCalledWith(8, '2026-11-16', expect.stringMatching(/^\d{4}-\d{2}-01$/));
    expect(res.body).toEqual({ success: true, data: PAUSED });
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'DORMITORY_STAY_UPDATED', expect.objectContaining({
      entityId: '8',
      details: expect.objectContaining({
        action: 'suspend', from: expect.objectContaining({ suspended: false }), to: expect.objectContaining({ suspended: true }),
      }),
    }));
  });

  it('возобновить: новая запись — DORMITORY_STAY_ADDED со ссылкой на паузу; повтор — 200 без аудита', async () => {
    svc.getStay.mockResolvedValue(PAUSED);
    pauseSvc.resumeCompensation.mockResolvedValue({ before: PAUSED, after: RESUMED, repeated: false });
    let res = makeRes();
    await c.resume(makeReq({ body: { date: '2026-12-01' } }), res);
    expect(res.body).toEqual({ success: true, data: RESUMED });
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'DORMITORY_STAY_ADDED', expect.objectContaining({
      entityId: '9', details: expect.objectContaining({ action: 'resume', resumed_from_id: 8 }),
    }));

    audit.logFromRequest.mockClear();
    pauseSvc.resumeCompensation.mockResolvedValue({ before: PAUSED, after: RESUMED, repeated: true });
    res = makeRes();
    await c.resume(makeReq({ body: { date: '2026-12-01' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('отказы сервиса — статус и текст; 404 без записи; 403 без доступа к сотруднику', async () => {
    pauseSvc.resumeCompensation.mockResolvedValue('already_resumed');
    let res = makeRes();
    await c.resume(makeReq({ body: { date: '2026-12-05' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('Компенсация уже возобновлена с другой даты');

    pauseSvc.finishCompensationPause.mockResolvedValue('not_paused');
    res = makeRes();
    await c.finish(makeReq(), res);
    expect(res.statusCode).toBe(400);

    svc.getStay.mockResolvedValue(null);
    res = makeRes();
    await c.suspend(makeReq({ body: { date: '2026-11-16' } }), res);
    expect(res.statusCode).toBe(404);

    svc.getStay.mockResolvedValue(COMP);
    access.canWriteStay.mockResolvedValue(false);
    res = makeRes();
    await c.suspend(makeReq({ body: { date: '2026-11-16' } }), res);
    expect(res.statusCode).toBe(403);
    expect(pauseSvc.suspendCompensation).not.toHaveBeenCalled();
  });
});
