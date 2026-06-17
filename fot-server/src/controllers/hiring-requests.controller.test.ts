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

const { mgr, recruiter, assignees, autoAccess } = vi.hoisted(() => ({
  mgr: vi.fn(async () => false),
  recruiter: vi.fn(async () => false),
  assignees: vi.fn(async () => [] as number[]),
  autoAccess: vi.fn(async () => true),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  isHiringManagerByEmployee: mgr,
  isRecruiter: recruiter,
  getActiveAssigneeEmployeeIds: assignees,
  hasActiveHiringAssignment: vi.fn(async () => false),
  hasHiringAutoAccess: autoAccess,
}));

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
