import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Вкладки «Проживание» и «Удержания» в назначениях (миграция 351): охват «вся организация» у выдающего на выдачу и на
 * снятие, выдача только работающему не подрядчику, независимость двух галочек, аудит в транзакции, обновление профиля.
 */

const { h } = vi.hoisted(() => ({
  h: {
    query: vi.fn(),
    queryOne: vi.fn(),
    client: { query: vi.fn() },
    scope: vi.fn(),
    state: vi.fn(),
    load: vi.fn(),
    set: vi.fn(),
    audit: vi.fn(),
    emit: vi.fn(),
    to: vi.fn(),
    committed: [] as string[],
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  // Транзакция как в жизни: ошибка внутри — изменение не фиксируется.
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>) => {
    const result = await fn(h.client);
    h.committed.push('commit');
    return result;
  },
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { logFromRequestWithClient: h.audit } }));
vi.mock('../services/data-scope.service.js', () => ({ resolveAccessibleDepartmentIds: h.scope }));
vi.mock('../services/dormitory-stays.service.js', () => ({ getEmployeeState: h.state }));
vi.mock('../services/staff-tab-access.service.js', () => ({
  loadStaffTabGrant: h.load,
  setStaffTabGrant: h.set,
}));
vi.mock('../socket/io-instance.js', () => ({
  getIo: () => ({ to: (room: string) => { h.to(room); return { emit: h.emit }; } }),
}));

const { staffTabAccessController } = await import('./staff-tab-access.controller.js');

const EMPLOYEE = 441;

const makeReq = (id: unknown, body: unknown = {}): AuthenticatedRequest => ({
  params: { id: String(id) },
  body,
  user: { id: 'hr-admin-user', employee_id: 10, role_code: 'hr_admin', is_admin: false },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = { statusCode: 200, body: null as unknown } as {
    statusCode: number; body: any; status: (c: number) => unknown; json: (b: unknown) => unknown;
  };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; });
  return res;
};

type Tab = 'dormitory' | 'deductions';

const put = async (body: unknown, tab: Tab = 'deductions', id: unknown = EMPLOYEE) => {
  const res = makeRes();
  await staffTabAccessController[tab].set(makeReq(id, body), res as unknown as Response);
  return res;
};

const get = async (tab: Tab = 'deductions', id: unknown = EMPLOYEE) => {
  const res = makeRes();
  await staffTabAccessController[tab].get(makeReq(id), res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.committed.length = 0;
  h.queryOne.mockImplementation(async (_sql: string, params: unknown[]) => (
    params[0] === EMPLOYEE ? { id: EMPLOYEE, full_name: 'Гладкая Наталья Васильевна' } : null
  ));
  h.query.mockResolvedValue([{ id: 'profile-1' }, { id: 'profile-2' }]);
  h.scope.mockResolvedValue('all');
  h.state.mockResolvedValue({ id: EMPLOYEE, employment_status: 'active', is_archived: false, is_contractor: false });
  h.load.mockResolvedValue(false);
  h.set.mockResolvedValue(true);
  h.audit.mockResolvedValue(undefined);
});

describe('GET /admin/employees/:id/{tab}-access', () => {
  it('отдаёт галочку своей вкладки', async () => {
    h.load.mockImplementation(async (_id: number, tab: Tab) => tab === 'dormitory');
    expect((await get('dormitory')).body.data).toEqual({ granted: true });
    expect((await get('deductions')).body.data).toEqual({ granted: false });
    expect(h.load).toHaveBeenCalledWith(EMPLOYEE, 'dormitory');
    expect(h.load).toHaveBeenCalledWith(EMPLOYEE, 'deductions');
  });

  it('некорректный id — 400, нет сотрудника — 404, выдающий без всей организации — 403', async () => {
    expect((await get('deductions', 'abc')).statusCode).toBe(400);
    expect((await get('deductions', 404404)).statusCode).toBe(404);
    h.scope.mockResolvedValue(['dept-1']);
    expect((await get()).statusCode).toBe(403);
    expect(h.load).not.toHaveBeenCalled();
  });

  it('ошибка базы — 500, а не «нет доступа»', async () => {
    h.load.mockRejectedValue(new Error('db down'));
    expect((await get()).statusCode).toBe(500);
  });
});

describe('PUT /admin/employees/:id/{tab}-access', () => {
  it('поставить: своя вкладка, аудит в той же транзакции, оповещение всем учёткам сотрудника', async () => {
    const res = await put({ granted: true }, 'dormitory');
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ granted: true });
    expect(h.set).toHaveBeenCalledWith(h.client, EMPLOYEE, 'dormitory', true, 'hr-admin-user');
    expect(h.audit).toHaveBeenCalledWith(
      h.client, expect.anything(), 'hr-admin-user', 'EMPLOYEE_STAFF_TAB_ACCESS_CHANGED',
      expect.objectContaining({
        entityId: String(EMPLOYEE),
        details: expect.objectContaining({ tab: 'dormitory', granted: true }),
      }),
    );
    expect(h.to).toHaveBeenCalledWith('user:profile-1');
    expect(h.to).toHaveBeenCalledWith('user:profile-2');
    expect(h.emit).toHaveBeenCalledTimes(2);
  });

  it('две галочки независимы: каждая вкладка пишет только свою', async () => {
    await put({ granted: true }, 'deductions');
    await put({ granted: false }, 'dormitory');
    expect(h.set.mock.calls.map(c => [c[2], c[3]])).toEqual([['deductions', true], ['dormitory', false]]);
  });

  it('повтор без изменений — ни аудита, ни оповещения', async () => {
    h.set.mockResolvedValue(false);
    expect((await put({ granted: true })).statusCode).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('ошибка аудита — 500, транзакция не фиксируется, оповещения нет', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));
    expect((await put({ granted: true })).statusCode).toBe(500);
    expect(h.committed).toEqual([]);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('выдача уволенному, архивному, подрядчику — 400; снять у них можно', async () => {
    const refused = [
      { employment_status: 'fired', is_archived: false, is_contractor: false },
      { employment_status: 'active', is_archived: true, is_contractor: false },
      { employment_status: 'active', is_archived: false, is_contractor: true },
    ];
    for (const state of refused) {
      h.state.mockResolvedValue({ id: EMPLOYEE, ...state });
      expect((await put({ granted: true })).statusCode, JSON.stringify(state)).toBe(400);
      expect((await put({ granted: false })).statusCode, JSON.stringify(state)).toBe(200);
    }
    expect(h.set.mock.calls.every(c => c[3] === false)).toBe(true);
  });

  it('выдающий без всей организации — 403 и на выдачу, и на снятие', async () => {
    h.scope.mockResolvedValue(['dept-1']);
    expect((await put({ granted: true })).statusCode).toBe(403);
    expect((await put({ granted: false })).statusCode).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('некорректное тело — 400, нет сотрудника — 404', async () => {
    expect((await put({ granted: 'yes' })).statusCode).toBe(400);
    expect((await put({ granted: true }, 'deductions', 404404)).statusCode).toBe(404);
    expect(h.set).not.toHaveBeenCalled();
  });
});
