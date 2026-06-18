import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute, pgTx, txClient } = vi.hoisted(() => {
  const txClient = { query: vi.fn() };
  return {
    pgQuery: vi.fn(async () => []),
    pgQueryOne: vi.fn(async () => null),
    pgExecute: vi.fn(async () => 1),
    pgTx: vi.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
    txClient,
  };
});
vi.mock('../config/postgres.js', () => ({
  query: pgQuery, queryOne: pgQueryOne, execute: pgExecute, withTransaction: pgTx,
}));

const { mgr, recruiter, assignees, autoAccess, hrManagers } = vi.hoisted(() => ({
  mgr: vi.fn(async () => false),
  recruiter: vi.fn(async () => false),
  assignees: vi.fn(async () => [] as number[]),
  autoAccess: vi.fn(async () => true),
  hrManagers: vi.fn(async () => [] as number[]),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  isHiringManagerByEmployee: mgr,
  isRecruiter: recruiter,
  getActiveAssigneeEmployeeIds: assignees,
  getHiringManagerEmployeeIds: hrManagers,
  hasActiveHiringAssignment: vi.fn(async () => false),
  hasHiringAutoAccess: autoAccess,
  isHiringRequesterRole: (code: string) => code === 'manager' || code === 'manager_obj',
}));

const { userIdsByEmp, createMany, sendPush } = vi.hoisted(() => ({
  userIdsByEmp: vi.fn(async () => [] as string[]),
  createMany: vi.fn(async () => undefined),
  sendPush: vi.fn(async () => undefined),
}));
vi.mock('../services/recipients.service.js', () => ({ getUserIdsByEmployeeIds: userIdsByEmp }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { createMany } }));
vi.mock('../services/push.service.js', () => ({ pushService: { sendGenericNotification: sendPush } }));

const { pageView } = vi.hoisted(() => ({ pageView: vi.fn(async () => false) }));
vi.mock('../services/access-control.service.js', () => ({ hasPageView: pageView }));
vi.mock('../services/r2.service.js', () => ({ r2Service: { isEnabledAsync: vi.fn(async () => true), generateHiringRequestKey: vi.fn(() => 'k'), uploadObject: vi.fn(), deleteObject: vi.fn(), generateDownloadUrl: vi.fn(async () => 'url') } }));

import { hiringRequestsController as c } from './hiring-requests.controller.js';

function makeReq(o: Partial<AuthenticatedRequest> & { body?: unknown; params?: Record<string, string>; query?: Record<string, unknown> } = {}): AuthenticatedRequest {
  return {
    params: o.params ?? {},
    query: o.query ?? {},
    body: o.body ?? {},
    user: { id: 'u1', employee_id: 10, role_code: 'office', is_admin: false, ...(o.user as object ?? {}) },
  } as unknown as AuthenticatedRequest;
}
function makeRes(): Response & { _status: number; _json: unknown } {
  const res = { _status: 200, _json: null } as Response & { _status: number; _json: unknown };
  res.status = vi.fn((s: number) => { res._status = s; return res; }) as unknown as Response['status'];
  res.json = vi.fn((j: unknown) => { res._json = j; return res; }) as unknown as Response['json'];
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mgr.mockResolvedValue(false); recruiter.mockResolvedValue(false);
  assignees.mockResolvedValue([]); pageView.mockResolvedValue(false);
  hrManagers.mockResolvedValue([]); userIdsByEmp.mockResolvedValue([]);
  pgQuery.mockResolvedValue([]); pgQueryOne.mockResolvedValue(null); pgExecute.mockResolvedValue(1);
});

describe('create', () => {
  it('403 если нет права создания', async () => {
    const res = makeRes();
    await c.create(makeReq({ body: { position_title: 'Прораб' } }), res);
    expect(res._status).toBe(403);
  });
  it('201 для роли-создателя (role-based view)', async () => {
    pageView.mockResolvedValue(true);
    pgQueryOne.mockResolvedValueOnce({ org_department_id: 'd1' }).mockResolvedValueOnce({ id: 5 });
    const res = makeRes();
    await c.create(makeReq({ body: { position_title: 'Прораб', headcount: 2 } }), res);
    expect(res._status).toBe(201);
  });
  it('201 для роли manager без page-view гранта', async () => {
    pgQueryOne.mockResolvedValueOnce({ org_department_id: 'd1', full_name: 'Иванов И.И.' }).mockResolvedValueOnce({ id: 5 });
    const res = makeRes();
    await c.create(makeReq({ user: { role_code: 'manager' }, body: { position_title: 'Прораб' } }), res);
    expect(res._status).toBe(201);
  });
  it('403 для timekeeper (регресс: не должен получить доступ)', async () => {
    const res = makeRes();
    await c.create(makeReq({ user: { role_code: 'timekeeper' }, body: { position_title: 'Прораб' } }), res);
    expect(res._status).toBe(403);
  });
  it('автозаполняет заказчика ФИО автора, hh=null, дату из CURRENT_DATE', async () => {
    pgQueryOne.mockResolvedValueOnce({ org_department_id: 'd1', full_name: 'Иванов И.И.' }).mockResolvedValueOnce({ id: 5 });
    const res = makeRes();
    await c.create(makeReq({ user: { role_code: 'manager_obj' }, body: { position_title: 'Прораб', customer_name: 'Хакер', hh_vacancy_url: 'evil' } }), res);
    expect(res._status).toBe(201);
    const insertParams = pgQueryOne.mock.calls[1][1] as unknown[];
    expect(insertParams[4]).toBe('Иванов И.И.'); // customer_name = ФИО автора
    expect(insertParams[6]).toBeNull();           // start_work_date → COALESCE CURRENT_DATE
    expect(insertParams[14]).toBeNull();          // hh_vacancy_url игнорируется при create
  });
  it('уведомляет руководителя ОК (type=hiring_request), исключая автора', async () => {
    hrManagers.mockResolvedValue([10, 20]); // 10 — сам автор, 20 — другой руководитель ОК
    userIdsByEmp.mockResolvedValue(['hr-user']);
    pgQueryOne.mockResolvedValueOnce({ org_department_id: 'd1', full_name: 'Иванов И.И.' }).mockResolvedValueOnce({ id: 7 });
    const res = makeRes();
    await c.create(makeReq({ user: { role_code: 'manager', employee_id: 10 }, body: { position_title: 'Прораб', headcount: 2 } }), res);
    await new Promise(r => setImmediate(r)); // дождаться fire-and-forget оповещения
    expect(userIdsByEmp).toHaveBeenCalledWith([20]); // автор (10) исключён
    expect(createMany).toHaveBeenCalledTimes(1);
    const items = createMany.mock.calls[0][0] as Array<{ userId: string; type: string }>;
    expect(items).toEqual([expect.objectContaining({ userId: 'hr-user', type: 'hiring_request' })]);
    expect(sendPush).toHaveBeenCalledTimes(1);
  });
  it('не шлёт уведомление, если руководителей ОК нет', async () => {
    hrManagers.mockResolvedValue([]);
    pgQueryOne.mockResolvedValueOnce({ org_department_id: 'd1', full_name: 'Иванов И.И.' }).mockResolvedValueOnce({ id: 8 });
    const res = makeRes();
    await c.create(makeReq({ user: { role_code: 'manager' }, body: { position_title: 'Прораб' } }), res);
    await new Promise(r => setImmediate(r));
    expect(createMany).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('updateFields (роль-зависимые поля)', () => {
  it('автор не может менять hh_vacancy_url (поле игнорируется)', async () => {
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 10, stage: 'new' });
    const res = makeRes();
    await c.updateFields(makeReq({ params: { id: '1' }, body: { hh_vacancy_url: 'x' } }), res);
    expect(res._json).toMatchObject({ success: true });
    expect(pgExecute).not.toHaveBeenCalled();
  });
  it('ответственный-рекрутер меняет только hh_vacancy_url', async () => {
    assignees.mockResolvedValue([10]);
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 99, stage: 'in_progress' });
    const res = makeRes();
    await c.updateFields(makeReq({ params: { id: '1' }, body: { hh_vacancy_url: 'http://x', position_title: 'Z' } }), res);
    expect(res._json).toMatchObject({ success: true });
    expect(pgExecute).toHaveBeenCalledTimes(1);
    const sql = (pgExecute.mock.calls[0][0] as string);
    expect(sql).toContain('hh_vacancy_url');
    expect(sql).not.toContain('position_title');
  });
  it('403 если не автор, не manage и не ответственный', async () => {
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 99, stage: 'closed' });
    const res = makeRes();
    await c.updateFields(makeReq({ params: { id: '1' }, body: { position_title: 'Z' } }), res);
    expect(res._status).toBe(403);
  });
});

describe('changeStage', () => {
  it('400 на rework через stage', async () => {
    const res = makeRes();
    await c.changeStage(makeReq({ params: { id: '1' }, body: { stage: 'rework' } }), res);
    expect(res._status).toBe(400);
  });
  it('403 если не ассайни и не manage', async () => {
    const res = makeRes();
    await c.changeStage(makeReq({ params: { id: '1' }, body: { stage: 'interview' } }), res);
    expect(res._status).toBe(403);
  });
  it('ок для ассайни', async () => {
    assignees.mockResolvedValue([10]);
    pgQueryOne.mockResolvedValueOnce({ stage: 'new' });
    const res = makeRes();
    await c.changeStage(makeReq({ params: { id: '1' }, body: { stage: 'interview' } }), res);
    expect(res._json).toMatchObject({ success: true });
  });
});

describe('reject', () => {
  it('400 без причины', async () => {
    mgr.mockResolvedValue(true);
    const res = makeRes();
    await c.reject(makeReq({ params: { id: '1' }, body: {} }), res);
    expect(res._status).toBe(400);
  });
  it('403 если не manage', async () => {
    const res = makeRes();
    await c.reject(makeReq({ params: { id: '1' }, body: { reason: 'x' } }), res);
    expect(res._status).toBe(403);
  });
});

describe('resubmit', () => {
  it('400 если не на доработке', async () => {
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 10, stage: 'new' });
    const res = makeRes();
    await c.resubmit(makeReq({ params: { id: '1' } }), res);
    expect(res._status).toBe(400);
  });
});

describe('addAssignee', () => {
  it('400 если сотрудник не в пуле', async () => {
    mgr.mockResolvedValue(true);
    recruiter.mockResolvedValue(false);
    const res = makeRes();
    await c.addAssignee(makeReq({ params: { id: '1' }, body: { employee_id: 77 } }), res);
    expect(res._status).toBe(400);
  });
});

describe('removeRecruiter', () => {
  it('403 если не manage', async () => {
    const res = makeRes();
    await c.removeRecruiter(makeReq({ params: { employeeId: '5' } }), res);
    expect(res._status).toBe(403);
  });
});

describe('approveCandidate', () => {
  it('409 при превышении headcount (транзакционный гард)', async () => {
    mgr.mockResolvedValue(true);
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 99 }); // request
    txClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [{ headcount: 1 }] };
      if (sql.includes('SELECT 1 FROM hiring_candidates WHERE id')) return { rowCount: 1, rows: [{}] };
      if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: 1 }] }; // уже 1 утверждён → +1 > 1
      return { rows: [] };
    });
    const res = makeRes();
    await c.approveCandidate(makeReq({ params: { id: '1', cid: '2' }, body: { approved: true } }), res);
    expect(res._status).toBe(409);
  });
  it('403 если не автор и не manage', async () => {
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 99 });
    const res = makeRes();
    await c.approveCandidate(makeReq({ params: { id: '1', cid: '2' }, body: { approved: true } }), res);
    expect(res._status).toBe(403);
  });
});

describe('finalizeSelection', () => {
  it('400 если 0 утверждённых', async () => {
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 10, headcount: 2 }).mockResolvedValueOnce({ n: 0 });
    const res = makeRes();
    await c.finalizeSelection(makeReq({ params: { id: '1' }, body: {} }), res);
    expect(res._status).toBe(400);
  });
  it('400 при частичном без confirm_partial', async () => {
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 10, headcount: 3 }).mockResolvedValueOnce({ n: 1 });
    const res = makeRes();
    await c.finalizeSelection(makeReq({ params: { id: '1' }, body: {} }), res);
    expect(res._status).toBe(400);
    expect((res._json as { code?: string }).code).toBe('PARTIAL');
  });
  it('ок при частичном с confirm_partial', async () => {
    pgQueryOne.mockResolvedValueOnce({ author_employee_id: 10, headcount: 3 }).mockResolvedValueOnce({ n: 1 });
    const res = makeRes();
    await c.finalizeSelection(makeReq({ params: { id: '1' }, body: { confirm_partial: true } }), res);
    expect(res._json).toMatchObject({ success: true });
  });
});

describe('analytics', () => {
  it('403 если не manage', async () => {
    const res = makeRes();
    await c.analytics(makeReq({ query: { period: 'month' } }), res);
    expect(res._status).toBe(403);
  });
});
