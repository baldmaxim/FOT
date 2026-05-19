import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const mockedState = vi.hoisted(() => ({
  scope: 'all' as 'all' | 'department' | 'self' | null,
}));

vi.mock('../services/schedule.service.js', () => ({
  resolveSchedule: vi.fn(),
  resolveSchedulesBulk: vi.fn(),
  // computeNetWorkHours используется в контроллере при create/update. В наших
  // тестах bulkApplyToBrigades путь его не вызывает, но импорт обязан резолвиться.
  computeNetWorkHours: vi.fn(() => 8),
}));

vi.mock('../services/data-scope.service.js', () => ({
  resolveRequestDataScope: vi.fn(async () => mockedState.scope),
  canAccessEmployeeInScope: vi.fn(async () => true),
  resolveScopedDepartmentIds: vi.fn(async (req: AuthenticatedRequest, departmentIds?: string[] | null) => {
    if (mockedState.scope !== 'department') {
      return departmentIds || [];
    }
    const allowedDepartmentId = req.user.department_id;
    return (departmentIds || []).filter(departmentId => departmentId === allowedDepartmentId);
  }),
}));

// collectDeptIds расширяет выбранную бригаду дочерними отделами. В юнит-тестах
// бригады плоские → возвращаем сам id (детерминированно, без обращения к БД).
vi.mock('../services/skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (id: string) => [id]),
}));

import { scheduleController } from './schedule.controller.js';

const BRIGADE_1 = '11111111-1111-4111-8111-111111111111';
const BRIGADE_2 = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: {},
    user: {
      id: 'user-1',
      email: 'admin@example.com',
      position_type: 'admin',
      employee_id: 7,
      department_id: BRIGADE_1,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
    ...overrides,
  } as AuthenticatedRequest;
}

function makeRes() {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };

  return response as Response & { statusCode: number; payload: unknown };
}

describe('scheduleController.bulkApplyToBrigades', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockedState.scope = 'all';
  });

  it('rejects invalid payload before touching the database', async () => {
    const req = makeReq({
      body: {
        department_ids: ['not-a-uuid'],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(400);
    expect(pgQuery).not.toHaveBeenCalled();
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('assigns a schedule to active employees from selected brigades', async () => {
    // Бэйс-маршрутизация SELECT'ов: org_departments → 2 бригады, employees → 101,102,
    // employee_schedule_assignments → у 102 уже есть назначение от 2026-04-01.
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from org_departments')) {
        return [
          { id: BRIGADE_1, name: 'Бр. Монолит', kind: 'brigade' },
          { id: BRIGADE_2, name: ' бр. Отделка ', kind: 'brigade' },
        ];
      }
      if (lower.includes('from employees')) {
        return [{ id: 101 }, { id: 102 }];
      }
      if (lower.includes('from employee_schedule_assignments')) {
        // loadEmployeeScheduleRowsBatch
        return [
          {
            id: 'existing-102',
            employee_id: 102,
            schedule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            effective_from: '2026-04-01',
            effective_to: null,
          },
        ];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    // Внутри assignEmployeeSchedule выполняется queryOne SELECT ... WHERE a.id = $1
    // (загрузка возвращаемой строки) и queryOne INSERT ... RETURNING id.
    // Любая возвращённая запись подходит — мы проверяем только агрегаты в ответе.
    let insertCounter = 0;
    pgQueryOne.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.startsWith('insert into employee_schedule_assignments')) {
        insertCounter += 1;
        return { id: `new-${insertCounter}` };
      }
      // SELECT ... WHERE a.id = $1 после insert/update
      return { id: 'fetched' };
    });

    pgExecute.mockResolvedValue(1);

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1, BRIGADE_2],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        departments_processed: 2,
        employees_matched: 2,
        employees_updated: 2,
        employees_failed: 0,
        sample_errors: [],
      },
    });

    // 2 INSERT-а: новые назначения сотрудникам 101 и 102.
    const insertCalls = pgQueryOne.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.toLowerCase().startsWith('insert into employee_schedule_assignments'),
    );
    expect(insertCalls).toHaveLength(2);

    // UPDATE закрывает старое назначение existing-102 предыдущей датой относительно 2026-04-20.
    const updateClosureCalls = pgExecute.mock.calls.filter(([sql, params]) => (
      typeof sql === 'string'
      && sql.toLowerCase().includes('update employee_schedule_assignments')
      && sql.toLowerCase().includes('set effective_to')
      && Array.isArray(params)
      && (params as unknown[]).includes('existing-102')
      && (params as unknown[]).includes('2026-04-19')
    ));
    expect(updateClosureCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('resets personal schedules and reports only actually updated employees', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from org_departments')) {
        return [{ id: BRIGADE_1, name: 'Бр. 1', kind: 'brigade' }];
      }
      if (lower.includes('from employees')) {
        return [{ id: 201 }, { id: 202 }];
      }
      if (lower.includes('from employee_schedule_assignments')) {
        // У 201 есть активное назначение, у 202 нет ничего → reset для 202 вернёт false.
        return [
          {
            id: 'existing-201',
            employee_id: 201,
            schedule_id: SCHEDULE_ID,
            effective_from: '2026-04-01',
            effective_to: null,
          },
        ];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    pgQueryOne.mockResolvedValue({ id: 'fetched' });
    pgExecute.mockResolvedValue(1);

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1],
        action: 'reset',
        effective_date: '2026-04-25',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        departments_processed: 1,
        employees_matched: 2,
        employees_updated: 1,
        employees_failed: 0,
        sample_errors: [],
      },
    });

    // Для existing-201 (effective_from < 2026-04-25) reset делает UPDATE effective_to=2026-04-24.
    const updateClosure = pgExecute.mock.calls.find(([sql, params]) => (
      typeof sql === 'string'
      && sql.toLowerCase().includes('update employee_schedule_assignments')
      && sql.toLowerCase().includes('set effective_to')
      && Array.isArray(params)
      && (params as unknown[]).includes('existing-201')
      && (params as unknown[]).includes('2026-04-24')
    ));
    expect(updateClosure).toBeTruthy();
  });

  it('rejects departments that are not brigades', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.toLowerCase().includes('from org_departments')) {
        return [{ id: BRIGADE_1, name: 'Отдел снабжения', kind: 'department' }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ success: false, error: 'Можно выбирать только отделы-бригады' });
    // Дальше списка отделов не уходим.
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects selection outside department scope', async () => {
    mockedState.scope = 'department';
    const req = makeReq({
      body: {
        department_ids: [BRIGADE_2],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ success: false, error: 'Можно назначать график только по своей бригаде' });
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('returns success when selected brigades have no active employees', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from org_departments')) {
        return [{ id: BRIGADE_1, name: 'Бр. 1', kind: 'brigade' }];
      }
      if (lower.includes('from employees')) {
        return [];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        departments_processed: 1,
        employees_matched: 0,
        employees_updated: 0,
        employees_failed: 0,
        sample_errors: [],
        note: 'В выбранных бригадах нет активных сотрудников (исключённые из табеля, архивные и уволенные не учитываются)',
      },
    });
  });

  it('one failing employee does not abort the batch (allSettled)', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from org_departments')) {
        return [{ id: BRIGADE_1, name: 'Бр. 1', kind: 'brigade' }];
      }
      if (lower.includes('from employees')) {
        return [{ id: 301 }, { id: 302 }];
      }
      if (lower.includes('from employee_schedule_assignments')) {
        return []; // нет преднастроек → путь Case 3 (INSERT)
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    // Первый INSERT успешен, второй возвращает null → assignEmployeeSchedule
    // бросает «Failed to insert…». allSettled должен это поглотить.
    let insertCounter = 0;
    pgQueryOne.mockImplementation(async (sql: string) => {
      if (sql.toLowerCase().startsWith('insert into employee_schedule_assignments')) {
        insertCounter += 1;
        return insertCounter === 1 ? { id: 'new-1' } : null;
      }
      return { id: 'fetched' };
    });
    pgExecute.mockResolvedValue(1);

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-20',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    const data = (res.payload as { data: Record<string, unknown> }).data;
    expect(data.departments_processed).toBe(1);
    expect(data.employees_matched).toBe(2);
    expect(data.employees_updated).toBe(1);
    expect(data.employees_failed).toBe(1);
    expect((data.sample_errors as string[]).length).toBe(1);
    expect(data.note).toContain('Не удалось обновить 1 из 2');
  });
});
