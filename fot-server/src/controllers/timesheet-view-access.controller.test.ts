import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Вкладка «Просмотр табеля» (миграция 309): валидация, зона доступа админа компании,
 * аудит в транзакции и сброс кэшей табеля после сохранения.
 */

const { h } = vi.hoisted(() => ({
  h: {
    query: vi.fn(),
    queryOne: vi.fn(),
    client: { query: vi.fn() },
    accessible: vi.fn(),
    canAccess: vi.fn(),
    canWrite: vi.fn(),
    currentIds: vi.fn(),
    assignments: vi.fn(),
    replace: vi.fn(),
    audit: vi.fn(),
    invalidate: vi.fn(),
    emit: vi.fn(),
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>) => fn(h.client),
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: h.invalidate }));
vi.mock('../services/audit.service.js', () => ({ auditService: { logFromRequestWithClient: h.audit } }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccess,
  canWriteEmployeeInScope: h.canWrite,
  resolveAccessibleDepartmentIds: h.accessible,
}));
vi.mock('../services/employee-timesheet-view-access.service.js', () => ({
  listTimesheetViewAssignments: h.assignments,
  listTimesheetViewEmployeeIds: h.currentIds,
  replaceTimesheetViewEmployees: h.replace,
}));
vi.mock('../socket/io-instance.js', () => ({
  getIo: () => ({ to: () => ({ emit: h.emit }) }),
}));

const { timesheetViewAccessController } = await import('./timesheet-view-access.controller.js');

const VIEWER = 2562;
const IN_SCOPE = 1361;
const OUT_OF_SCOPE = 7777;

const makeReq = (id: unknown, body: unknown = {}): AuthenticatedRequest => ({
  params: { id: String(id) },
  body,
  user: { id: 'admin-user', employee_id: 1, role_code: 'admin', is_admin: true },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = { statusCode: 200, body: null as unknown } as { statusCode: number; body: unknown; status: (c: number) => unknown; json: (b: unknown) => unknown };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; });
  return res;
};

const put = async (body: unknown, viewer: unknown = VIEWER) => {
  const res = makeRes();
  await timesheetViewAccessController.replace(makeReq(viewer, body), res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.queryOne.mockImplementation(async (_sql: string, params: unknown[]) => (
    params[0] === VIEWER ? { id: VIEWER, full_name: 'Владимиров Иван Ильич' } : null
  ));
  h.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM employees WHERE id = ANY')) {
      return (params[0] as number[]).filter(id => id !== 404404).map(id => ({ id }));
    }
    if (sql.includes('FROM user_profiles')) return [{ id: 'profile-viewer' }];
    return [];
  });
  h.accessible.mockResolvedValue('all');
  h.canAccess.mockResolvedValue(true);
  h.canWrite.mockImplementation(async (_req: unknown, id: number) => id !== OUT_OF_SCOPE);
  h.currentIds.mockResolvedValue([]);
  h.assignments.mockResolvedValue([]);
  h.replace.mockResolvedValue({ added: [IN_SCOPE], removed: [] });
});

describe('PUT /admin/employees/:id/timesheet-view-employees — валидация', () => {
  it('некорректный id смотрящего → 400', async () => {
    expect((await put({ employee_ids: [] }, 'abc')).statusCode).toBe(400);
  });

  it('мусор в теле → 400', async () => {
    expect((await put({ employee_ids: ['x'] })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
  });

  it('сам себя → 400', async () => {
    expect((await put({ employee_ids: [VIEWER] })).statusCode).toBe(400);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('смотрящего нет → 404', async () => {
    expect((await put({ employee_ids: [] }, 555)).statusCode).toBe(404);
  });

  it('несуществующий сотрудник в списке → 400 с перечнем', async () => {
    const res = await put({ employee_ids: [IN_SCOPE, 404404] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ details: { missing_employee_ids: [404404] } });
    expect(h.replace).not.toHaveBeenCalled();
  });
});

describe('PUT — зона доступа админа компании', () => {
  beforeEach(() => {
    h.accessible.mockResolvedValue(['company-root']);
  });

  it('смотрящий в зоне, добавляемый вне зоны → 403, ничего не пишется', async () => {
    const res = await put({ employee_ids: [IN_SCOPE, OUT_OF_SCOPE] });
    expect(res.statusCode).toBe(403);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('смотрящий вне зоны → 403', async () => {
    h.canWrite.mockImplementation(async (_req: unknown, id: number) => id !== VIEWER);
    expect((await put({ employee_ids: [IN_SCOPE] })).statusCode).toBe(403);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('уже назначенного вне зоны можно оставить или снять: проверяются только добавляемые', async () => {
    h.currentIds.mockResolvedValue([OUT_OF_SCOPE]);
    expect((await put({ employee_ids: [OUT_OF_SCOPE, IN_SCOPE] })).statusCode).toBe(200);
    expect((await put({ employee_ids: [] })).statusCode).toBe(200);
    expect(h.canWrite).not.toHaveBeenCalledWith(expect.anything(), OUT_OF_SCOPE);
  });

  it('системный админ — без поштучной проверки', async () => {
    h.accessible.mockResolvedValue('all');
    expect((await put({ employee_ids: [OUT_OF_SCOPE] })).statusCode).toBe(200);
    expect(h.canWrite).not.toHaveBeenCalled();
  });
});

describe('PUT — сохранение', () => {
  it('изменение: замена + аудит в той же транзакции + сброс кэшей табеля и поиска + оповещение', async () => {
    const res = await put({ employee_ids: [IN_SCOPE, IN_SCOPE] });
    expect(res.statusCode).toBe(200);
    expect(h.replace).toHaveBeenCalledWith(h.client, VIEWER, [IN_SCOPE], 'admin-user');
    expect(h.audit).toHaveBeenCalledWith(
      h.client, expect.anything(), 'admin-user', 'EMPLOYEE_TIMESHEET_VIEW_ACCESS_CHANGED',
      expect.objectContaining({ details: expect.objectContaining({ added: [IN_SCOPE], removed: [] }) }),
    );
    expect(h.invalidate).toHaveBeenCalledWith(
      'timesheet', 'timesheet:today', 'timesheet:overview', 'timesheet:overview:today',
      'timesheet:search', 'timesheet:employee-search',
    );
    expect(h.emit).toHaveBeenCalledWith('profile:access_changed');
  });

  it('без изменений: ни аудита, ни сброса кэшей', async () => {
    h.replace.mockResolvedValue({ added: [], removed: [] });
    expect((await put({ employee_ids: [IN_SCOPE] })).statusCode).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('GET /admin/employees/:id/timesheet-view-employees', () => {
  it('смотрящий вне зоны → 403', async () => {
    h.canAccess.mockResolvedValue(false);
    const res = makeRes();
    await timesheetViewAccessController.list(makeReq(VIEWER), res as unknown as Response);
    expect(res.statusCode).toBe(403);
  });

  it('отдаёт назначенных', async () => {
    h.assignments.mockResolvedValue([{ employee_id: IN_SCOPE, full_name: 'Остриогло Вадим Иванович', employment_status: 'active' }]);
    const res = makeRes();
    await timesheetViewAccessController.list(makeReq(VIEWER), res as unknown as Response);
    expect(res.body).toEqual({
      success: true,
      data: [{ employee_id: IN_SCOPE, full_name: 'Остриогло Вадим Иванович', employment_status: 'active' }],
    });
  });
});
