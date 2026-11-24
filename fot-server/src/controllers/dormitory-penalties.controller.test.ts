import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// «История взысканий» (миграция 378): охват по сотруднику, аудит, сотрудник записи не меняется, пустая — 400.

const penaltiesSvc = vi.hoisted(() => ({
  listPenalties: vi.fn(),
  penaltyMatchOf: vi.fn(),
  getPenalty: vi.fn(),
  addPenalty: vi.fn(),
  updatePenalty: vi.fn(),
  removePenalty: vi.fn(),
}));
vi.mock('../services/dormitory-penalties.service.js', () => penaltiesSvc);

const staysSvc = vi.hoisted(() => ({ getEmployeeState: vi.fn() }));
vi.mock('../services/dormitory-stays.service.js', () => staysSvc);

const scope = vi.hoisted(() => ({
  canWriteEmployeeInScope: vi.fn(),
  canSeeEmployeeInStaffList: vi.fn(),
  resolveStaffRosterEmployeeIds: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({ canWriteEmployeeInScope: scope.canWriteEmployeeInScope }));
vi.mock('../services/employee-scope-filter.service.js', () => ({
  canSeeEmployeeInStaffList: scope.canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds: scope.resolveStaffRosterEmployeeIds,
}));

const grant = vi.hoisted(() => ({ getRequestStaffTabGrant: vi.fn() }));
vi.mock('../services/staff-tab-access.service.js', () => grant);

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

vi.mock('../utils/date.utils.js', () => ({ moscowTodayIso: () => '2026-11-24' }));

import { dormitoryPenaltiesController as c } from './dormitory-penalties.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (over: Partial<{ params: Record<string, string>; query: Record<string, string>; body: unknown }> = {}) => ({
  user: { id: 'user-1' },
  params: {},
  query: {},
  body: {},
  ...over,
}) as unknown as AuthenticatedRequest;

const ACTIVE = { id: 42, employment_status: 'active', is_archived: false, is_contractor: false, dismissal_date: null };
const PENALTY = { id: 7, employee_id: 42, penalty_date: '2026-10-05', note: 'Драка в общежитии', source: 'manual' };

beforeEach(() => {
  vi.clearAllMocks();
  grant.getRequestStaffTabGrant.mockResolvedValue(false);
  scope.canWriteEmployeeInScope.mockResolvedValue(true);
  scope.canSeeEmployeeInStaffList.mockResolvedValue(false);
  staysSvc.getEmployeeState.mockResolvedValue(ACTIVE);
});

describe('«История взысканий»: доступ', () => {
  it('список — в охвате списка кадров; галочка «Проживание» — вся организация', async () => {
    scope.resolveStaffRosterEmployeeIds.mockResolvedValue(new Set([42]));
    penaltiesSvc.listPenalties.mockResolvedValue([]);
    await c.list(makeReq(), makeRes());
    expect(penaltiesSvc.listPenalties).toHaveBeenLastCalledWith([42]);

    grant.getRequestStaffTabGrant.mockResolvedValue(true);
    await c.list(makeReq(), makeRes());
    expect(penaltiesSvc.listPenalties).toHaveBeenLastCalledWith(null);
  });

  it('проверка чужого сотрудника (вне охвата) — 403, взыскания не читаются', async () => {
    scope.canWriteEmployeeInScope.mockResolvedValue(false);
    const res = makeRes();
    await c.check(makeReq({ query: { employee_id: '99' } }), res);
    expect(res.statusCode).toBe(403);
    expect(penaltiesSvc.penaltyMatchOf).not.toHaveBeenCalled();
  });

  it('проверка своего — ответ сервиса; без id — 400', async () => {
    penaltiesSvc.penaltyMatchOf.mockResolvedValue({ level: 'yes', items: [] });
    const res = makeRes();
    await c.check(makeReq({ query: { employee_id: '42' } }), res);
    expect(res.body).toEqual({ success: true, data: { level: 'yes', items: [] } });

    const bad = makeRes();
    await c.check(makeReq({ query: {} }), bad);
    expect(bad.statusCode).toBe(400);
  });

  it('добавить чужому — 403; уволенному, видному в «Уволенных», — можно', async () => {
    scope.canWriteEmployeeInScope.mockResolvedValue(false);
    const denied = makeRes();
    await c.add(makeReq({ body: { employee_id: 42, note: 'x' } }), denied);
    expect(denied.statusCode).toBe(403);
    expect(penaltiesSvc.addPenalty).not.toHaveBeenCalled();

    staysSvc.getEmployeeState.mockResolvedValue({ ...ACTIVE, employment_status: 'fired', dismissal_date: '2026-08-01' });
    scope.canSeeEmployeeInStaffList.mockResolvedValue(true);
    penaltiesSvc.addPenalty.mockResolvedValue(PENALTY);
    const res = makeRes();
    await c.add(makeReq({ body: { employee_id: 42, note: 'x' } }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe('«История взысканий»: запись', () => {
  it('добавить — информация без лишних пробелов, аудит ADDED', async () => {
    penaltyServiceAdd();
    const res = makeRes();
    await c.add(makeReq({ body: { employee_id: 42, penalty_date: '2026-10-05', note: '  Драка   в общежитии ' } }), res);
    expect(penaltiesSvc.addPenalty).toHaveBeenCalledWith(42, { penalty_date: '2026-10-05', note: 'Драка в общежитии' });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_PENALTY_ADDED', expect.objectContaining({ entityId: '7' }),
    );
  });

  it('пустая запись, дата в будущем или несуществующая — 400', async () => {
    for (const body of [
      { employee_id: 42 },
      { employee_id: 42, penalty_date: '', note: '   ' },
      { employee_id: 42, penalty_date: '2026-11-25' },
      { employee_id: 42, penalty_date: '2026-02-30' },
    ]) {
      const res = makeRes();
      await c.add(makeReq({ body }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(penaltiesSvc.addPenalty).not.toHaveBeenCalled();
  });

  it('правка: сотрудника не меняют — 400; без изменений — без аудита; иначе UPDATED (было → стало)', async () => {
    penaltiesSvc.getPenalty.mockResolvedValue(PENALTY);
    const withEmployee = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body: { employee_id: 43, note: 'y' } }), withEmployee);
    expect(withEmployee.statusCode).toBe(400);

    const same = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body: { penalty_date: '2026-10-05', note: 'Драка в общежитии' } }), same);
    expect(same.statusCode).toBe(200);
    expect(penaltiesSvc.updatePenalty).not.toHaveBeenCalled();
    expect(audit.logFromRequest).not.toHaveBeenCalled();

    penaltiesSvc.updatePenalty.mockResolvedValue({ before: PENALTY, after: { ...PENALTY, note: 'Курение' } });
    const res = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body: { penalty_date: '2026-10-05', note: 'Курение' } }), res);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_PENALTY_UPDATED',
      expect.objectContaining({ details: expect.objectContaining({ to: expect.objectContaining({ note: 'Курение' }) }) }),
    );
  });

  it('правка и удаление чужого — 403; нет записи — 404; удаление — аудит DELETED', async () => {
    penaltiesSvc.getPenalty.mockResolvedValue(null);
    const missing = makeRes();
    await c.remove(makeReq({ params: { id: '7' } }), missing);
    expect(missing.statusCode).toBe(404);

    penaltiesSvc.getPenalty.mockResolvedValue(PENALTY);
    scope.canWriteEmployeeInScope.mockResolvedValue(false);
    const deniedUpdate = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body: { note: 'z' } }), deniedUpdate);
    expect(deniedUpdate.statusCode).toBe(403);
    const deniedRemove = makeRes();
    await c.remove(makeReq({ params: { id: '7' } }), deniedRemove);
    expect(deniedRemove.statusCode).toBe(403);
    expect(penaltiesSvc.removePenalty).not.toHaveBeenCalled();

    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    penaltiesSvc.removePenalty.mockResolvedValue(PENALTY);
    const res = makeRes();
    await c.remove(makeReq({ params: { id: '7' } }), res);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_PENALTY_DELETED', expect.objectContaining({ entityId: '7' }),
    );
  });
});

function penaltyServiceAdd(): void {
  penaltiesSvc.addPenalty.mockImplementation(async (_employeeId: number, input: { penalty_date: string | null; note: string | null }) => ({
    ...PENALTY,
    ...input,
  }));
}
