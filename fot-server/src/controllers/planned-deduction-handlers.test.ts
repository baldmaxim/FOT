import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Обработчики плановых удержаний (миграция 357): проверка ввода (400, а не 500), месяцы списков, права (403),
// ответы 404/409 и аудит. Сервис и состояние сотрудника — заглушки; правила записи проверяет PG-тест.

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn(),
}));

const service = vi.hoisted(() => ({
  addPlannedDeduction: vi.fn(),
  getPlannedDeduction: vi.fn(),
  listPlannedDeductionMonths: vi.fn(async () => [{ id: 1, employee_id: 7, month: '2026-11' }]),
  listPlannedDeductions: vi.fn(async () => [{ id: 1, employee_id: 7 }, { id: 2, employee_id: 8 }]),
  removePlannedDeduction: vi.fn(),
  updatePlannedDeduction: vi.fn(),
}));
vi.mock('../services/payroll/payroll-planned-deductions.service.js', () => service);

const employees = vi.hoisted(() => ({
  getEmployeeState: vi.fn(async () => ({
    employment_status: 'active', dismissal_date: null, is_archived: false, is_contractor: false,
  })),
}));
vi.mock('../services/dormitory-stays.service.js', () => employees);

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

vi.mock('../utils/date.utils.js', () => ({ moscowTodayIso: () => '2026-11-10' }));

import { createPlannedDeductionHandlers } from './planned-deduction-handlers.js';

const access = {
  source: 'test',
  scope: vi.fn(async () => ({ kind: 'employees' as const, employeeIds: null })),
  canWrite: vi.fn(async (_req: AuthenticatedRequest, _employeeId: number) => true),
  editPredicate: vi.fn(async () => (employeeId: number) => employeeId === 7),
};
const handlers = createPlannedDeductionHandlers(access);

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
  user: { id: 'user-1' }, params: {}, query: {}, body: {}, ...over,
} as unknown as AuthenticatedRequest);

const ROW = {
  id: 5, employee_id: 7, full_name: 'Каримов Акмал', department: null, position: null,
  kind_id: 3, kind_name: 'Займ', subkind_id: null, subkind_name: null, amount: '5000.00',
  month_from: '2026-11', month_to: '2027-01', last_month_amount: null, updated_at: '2026-11-10T09:00:00.000001Z',
};
const BODY = { kind_id: 3, amount: 5000, month_from: '2026-11', month_to: '2027-01' };

beforeEach(() => {
  vi.clearAllMocks();
  access.canWrite.mockResolvedValue(true);
  service.getPlannedDeduction.mockResolvedValue(ROW);
});

describe('списки', () => {
  it('без months — текущий месяц МСК, all — все периоды; can_edit по строке', async () => {
    const res = makeRes();
    await handlers.list(makeReq(), res);
    expect(service.listPlannedDeductions).toHaveBeenLastCalledWith({ kind: 'employees', employeeIds: null }, ['2026-11-01']);
    expect(res.body.data.map((row: { can_edit: boolean }) => row.can_edit)).toEqual([true, false]);

    await handlers.list(makeReq({ query: { months: 'all' } }), makeRes());
    expect(service.listPlannedDeductions).toHaveBeenLastCalledWith(expect.anything(), null);

    await handlers.list(makeReq({ query: { months: '2026-12,2026-11' } }), makeRes());
    expect(service.listPlannedDeductions).toHaveBeenLastCalledWith(expect.anything(), ['2026-11-01', '2026-12-01']);
  });

  it('по месяцам: all — 400 (бессрочное не развернуть), без months — текущий, мусор — 400', async () => {
    const all = makeRes();
    await handlers.listByMonth(makeReq({ query: { months: 'all' } }), all);
    expect(all.statusCode).toBe(400);
    const bad = makeRes();
    await handlers.listByMonth(makeReq({ query: { months: '2026-13' } }), bad);
    expect(bad.statusCode).toBe(400);
    expect(service.listPlannedDeductionMonths).not.toHaveBeenCalled();

    await handlers.listByMonth(makeReq(), makeRes());
    expect(service.listPlannedDeductionMonths).toHaveBeenLastCalledWith(expect.anything(), ['2026-11-01']);
  });
});

describe('добавление', () => {
  it('ввод: «по» раньше «с», три знака, без вида, неверный месяц — 400 без записи', async () => {
    const bodies = [
      { ...BODY, month_to: '2026-10' },
      { ...BODY, amount: 10.005 },
      { ...BODY, kind_id: undefined },
      { ...BODY, month_from: '2026-1' },
      { ...BODY, amount: '5000' },
      // Сумма последнего месяца (миграция 362): у бессрочного, у периода в месяц, равная ежемесячной, ноль, три знака.
      { ...BODY, month_to: null, last_month_amount: 1000 },
      { ...BODY, month_to: '2026-11', last_month_amount: 1000 },
      { ...BODY, last_month_amount: 5000 },
      { ...BODY, last_month_amount: 0 },
      { ...BODY, last_month_amount: 1000.005 },
    ];
    for (const body of bodies) {
      const res = makeRes();
      await handlers.add(makeReq({ body: { employee_id: 7, ...body } }), res);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(service.addPlannedDeduction).not.toHaveBeenCalled();
  });

  it('уволенный — начало не позже месяца увольнения; нет права — 403', async () => {
    employees.getEmployeeState.mockResolvedValueOnce({
      employment_status: 'fired', dismissal_date: '2026-10-23', is_archived: false, is_contractor: false,
    });
    const fired = makeRes();
    await handlers.add(makeReq({ body: { employee_id: 7, ...BODY } }), fired);
    expect(fired.statusCode).toBe(400);
    expect(fired.body.error).toMatch(/не позже октября 2026/);

    access.canWrite.mockResolvedValueOnce(false);
    const denied = makeRes();
    await handlers.add(makeReq({ body: { employee_id: 7, ...BODY } }), denied);
    expect(denied.statusCode).toBe(403);
    expect(service.addPlannedDeduction).not.toHaveBeenCalled();
  });

  it('пересечение — 409 с периодом; вид удалён — 409; добавлено — аудит ADDED; бессрочно — month_to null', async () => {
    service.addPlannedDeduction.mockResolvedValueOnce({ conflict: 'exists', existing: { ...ROW, month_to: null } });
    const exists = makeRes();
    await handlers.add(makeReq({ body: { employee_id: 7, ...BODY } }), exists);
    expect(exists.statusCode).toBe(409);
    expect(exists.body).toMatchObject({ code: 'PLANNED_DEDUCTION_EXISTS' });
    expect(exists.body.error).toBe('У сотрудника уже есть плановое удержание «Займ» на ноябрь 2026 — бессрочно');

    service.addPlannedDeduction.mockResolvedValueOnce('kind_missing');
    const missing = makeRes();
    await handlers.add(makeReq({ body: { employee_id: 7, ...BODY } }), missing);
    expect(missing.statusCode).toBe(409);
    expect(missing.body.code).toBe('KIND_MISSING');

    service.addPlannedDeduction.mockResolvedValueOnce(ROW);
    const ok = makeRes();
    await handlers.add(makeReq({ body: { employee_id: 7, ...BODY, month_to: null } }), ok);
    expect(ok.body.data).toEqual(ROW);
    expect(service.addPlannedDeduction).toHaveBeenLastCalledWith(
      7, { kind_id: 3, subkind_id: null, amount: 5000, month_from: '2026-11', month_to: null, last_month_amount: null }, 'user-1',
    );
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'PAYROLL_PLANNED_DEDUCTION_ADDED',
      expect.objectContaining({ entityId: '5', details: expect.objectContaining({ source: 'test' }) }));
  });
});

describe('правка и «Убрать»', () => {
  const expected = { expected_updated_at: ROW.updated_at };

  it('без метки версии — 400; чужой сотрудник — 403; нет строки — 404', async () => {
    const noToken = makeRes();
    await handlers.update(makeReq({ params: { id: '5' }, body: BODY }), noToken);
    expect(noToken.statusCode).toBe(400);
    const noTokenRemove = makeRes();
    await handlers.remove(makeReq({ params: { id: '5' }, body: {} }), noTokenRemove);
    expect(noTokenRemove.statusCode).toBe(400);

    access.canWrite.mockResolvedValueOnce(false);
    const denied = makeRes();
    await handlers.update(makeReq({ params: { id: '5' }, body: { ...BODY, ...expected } }), denied);
    expect(denied.statusCode).toBe(403);

    service.getPlannedDeduction.mockResolvedValueOnce(null);
    const missing = makeRes();
    await handlers.remove(makeReq({ params: { id: '5' }, body: expected }), missing);
    expect(missing.statusCode).toBe(404);
    expect(service.updatePlannedDeduction).not.toHaveBeenCalled();
    expect(service.removePlannedDeduction).not.toHaveBeenCalled();
  });

  it('уже изменили — 409 STALE; без изменений — без аудита; правка — UPDATED', async () => {
    service.updatePlannedDeduction.mockResolvedValueOnce({ conflict: 'stale' });
    const stale = makeRes();
    await handlers.update(makeReq({ params: { id: '5' }, body: { ...BODY, ...expected } }), stale);
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe('PLANNED_DEDUCTION_STALE');

    service.updatePlannedDeduction.mockResolvedValueOnce({ before: ROW, after: ROW, changed: false });
    await handlers.update(makeReq({ params: { id: '5' }, body: { ...BODY, ...expected } }), makeRes());
    expect(audit.logFromRequest).not.toHaveBeenCalled();

    service.updatePlannedDeduction.mockResolvedValueOnce({ before: ROW, after: { ...ROW, amount: '6000.00' }, changed: true });
    const ok = makeRes();
    await handlers.update(makeReq({ params: { id: '5' }, body: { ...BODY, amount: 6000, ...expected } }), ok);
    expect(ok.body.data.amount).toBe('6000.00');
    expect(service.updatePlannedDeduction).toHaveBeenLastCalledWith(
      5, expect.objectContaining({ amount: 6000 }), ROW.updated_at, 'user-1',
    );
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'PAYROLL_PLANNED_DEDUCTION_UPDATED', expect.anything());
  });

  it('сумма последнего месяца: доходит до сервиса и в аудит; при «Бессрочно» — 400 без записи', async () => {
    const after = { ...ROW, last_month_amount: '1000.00' };
    service.updatePlannedDeduction.mockResolvedValueOnce({ before: ROW, after, changed: true });
    await handlers.update(makeReq({ params: { id: '5' }, body: { ...BODY, last_month_amount: 1000, ...expected } }), makeRes());
    expect(service.updatePlannedDeduction).toHaveBeenLastCalledWith(
      5, expect.objectContaining({ month_to: '2027-01', last_month_amount: 1000 }), ROW.updated_at, 'user-1',
    );
    expect(audit.logFromRequest).toHaveBeenLastCalledWith(expect.anything(), 'user-1', 'PAYROLL_PLANNED_DEDUCTION_UPDATED',
      expect.objectContaining({ details: expect.objectContaining({ to: expect.objectContaining({ last_month_amount: '1000.00' }) }) }));

    const endless = makeRes();
    await handlers.update(
      makeReq({ params: { id: '5' }, body: { ...BODY, month_to: null, last_month_amount: 1000, ...expected } }), endless,
    );
    expect(endless.statusCode).toBe(400);
    expect(endless.body.error).toBe('Другая сумма в последнем месяце — только если «По месяц» позже «С месяца»');
    expect(service.updatePlannedDeduction).toHaveBeenCalledTimes(1);
  });

  it('«Убрать»: текущий месяц МСК в сервис; закрыто — CLOSED, удалено — REMOVED, повтор — 409', async () => {
    service.removePlannedDeduction.mockResolvedValueOnce({ action: 'closed', before: ROW, after: { ...ROW, month_to: '2026-10' } });
    const closed = makeRes();
    await handlers.remove(makeReq({ params: { id: '5' }, body: expected }), closed);
    expect(closed.body).toMatchObject({ action: 'closed', data: { month_to: '2026-10' } });
    expect(service.removePlannedDeduction).toHaveBeenLastCalledWith(5, ROW.updated_at, '2026-11', 'user-1');

    service.removePlannedDeduction.mockResolvedValueOnce({ action: 'removed', before: ROW });
    const removed = makeRes();
    await handlers.remove(makeReq({ params: { id: '5' }, body: expected }), removed);
    expect(removed.body.action).toBe('removed');

    service.removePlannedDeduction.mockResolvedValueOnce({ conflict: 'stale' });
    const again = makeRes();
    await handlers.remove(makeReq({ params: { id: '5' }, body: expected }), again);
    expect(again.statusCode).toBe(409);

    expect(audit.logFromRequest.mock.calls.map(call => call[2])).toEqual([
      'PAYROLL_PLANNED_DEDUCTION_CLOSED', 'PAYROLL_PLANNED_DEDUCTION_REMOVED',
    ]);
  });
});
