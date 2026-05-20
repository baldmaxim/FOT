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

/**
 * Контроллер теперь оборачивает мутации в withTransaction(client => ...).
 * Фейковый клиент маршрутизирует SQL в те же моки query/queryOne/execute,
 * что и прод-хелперы (INSERT…RETURNING и SELECT…WHERE a.id=$1 → queryOne,
 * прочие SELECT → query, UPDATE/DELETE → execute) — существующие моки и
 * ассерты тестов остаются валидными.
 */
function makeTxClient() {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const lower = sql.trimStart().toLowerCase();
      if (lower.startsWith('insert')) {
        const row = await pgQueryOne(sql, params);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (lower.startsWith('select')) {
        if (lower.includes('where a.id = $1')) {
          const row = await pgQueryOne(sql, params);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        const rows = (await pgQuery(sql, params)) ?? [];
        return { rows, rowCount: rows.length };
      }
      if (lower.startsWith('update') || lower.startsWith('delete')) {
        const n = await pgExecute(sql, params);
        return { rows: [], rowCount: typeof n === 'number' ? n : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const installDefaultTx = () => {
  pgTx.mockImplementation(async (fn: (client: unknown) => unknown) => fn(makeTxClient()));
};

describe('scheduleController.bulkApplyToBrigades', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    installDefaultTx();
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

  // Регресс: после remove (закрытие effective_to в прошлое) повторный assign того
  // же графика на effective_date === existing.effective_from должен СБРОСИТЬ
  // effective_to в NULL, а не наследовать закрытую дату. Иначе бригада остаётся
  // на default-графике, хотя toast говорит «обновлено N из N».
  // См. план bright-roaming-cocke.md, шаг 1.
  it('in-place UPDATE сбрасывает закрытый effective_to в NULL при assign после remove', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from org_departments')) {
        return [{ id: BRIGADE_1, name: 'Бр. Курбоншоева', kind: 'brigade' }];
      }
      if (lower.includes('from employees')) {
        return [{ id: 92 }];
      }
      if (lower.includes('from employee_schedule_assignments')) {
        // Состояние после reset: запись того же графика закрыта вчера-2 относительно
        // запрошенной даты. nextAssignment === null. До фикса nextEffectiveTo
        // наследовал '2026-05-15' → видимое окно оставалось закрытым.
        return [
          {
            id: 'existing-92',
            employee_id: 92,
            schedule_id: SCHEDULE_ID,
            effective_from: '2026-04-27',
            effective_to: '2026-05-15',
          },
        ];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    pgQueryOne.mockResolvedValue({ id: 'existing-92' });
    pgExecute.mockResolvedValue(1);

    const req = makeReq({
      body: {
        department_ids: [BRIGADE_1],
        action: 'assign',
        schedule_id: SCHEDULE_ID,
        effective_date: '2026-04-27',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { employees_updated: number } }).data.employees_updated).toBe(1);

    // UPDATE с effective_to=null (NULL), а не '2026-05-15'.
    const updates = pgExecute.mock.calls.filter(([sql]) =>
      typeof sql === 'string'
      && sql.toLowerCase().includes('update employee_schedule_assignments')
      && sql.toLowerCase().includes('set schedule_id'));
    expect(updates).toHaveLength(1);
    const [, params] = updates[0];
    expect(Array.isArray(params)).toBe(true);
    expect((params as unknown[])[1]).toBe(null);   // effective_to → NULL
    expect((params as unknown[])[0]).toBe(SCHEDULE_ID); // schedule_id сохраняется
    expect((params as unknown[]).includes('existing-92')).toBe(true);
    // А не наследует закрытую дату:
    expect((params as unknown[]).includes('2026-05-15')).toBe(false);
  });

  // action='shift_start': сдвигает effective_from открытого назначения (effective_to=NULL)
  // назад, поглощая промежуточные исторические фрагменты и обрезая запись, активную на
  // новой дате. Сотрудников без открытого назначения операция не трогает.
  it('shift_start: двигает effective_from открытого назначения и удаляет промежуточные куски', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from org_departments')) {
        return [{ id: BRIGADE_1, name: 'Бр. Курбоншоева', kind: 'brigade' }];
      }
      if (lower.includes('from employees')) {
        return [{ id: 92 }, { id: 999 }];
      }
      if (lower.includes('from employee_schedule_assignments')) {
        // emp 92: история — два закрытых куска и один открытый, который надо сдвинуть с 2026-05-20 → 2026-04-01.
        // emp 999: НЕТ открытого назначения — должен быть пропущен (employees_updated не растёт).
        return [
          {
            id: 'closed-old',
            employee_id: 92,
            schedule_id: SCHEDULE_ID,
            effective_from: '2026-02-02',
            effective_to: '2026-04-12', // покрывает 2026-04-01 — будет обрезано на 2026-03-31
          },
          {
            id: 'between',
            employee_id: 92,
            schedule_id: SCHEDULE_ID,
            effective_from: '2026-04-13', // попадает в новый диапазон → DELETE
            effective_to: '2026-04-26',
          },
          {
            id: 'open',
            employee_id: 92,
            schedule_id: SCHEDULE_ID,
            effective_from: '2026-05-20',
            effective_to: null,
          },
          {
            id: 'closed-only',
            employee_id: 999,
            schedule_id: SCHEDULE_ID,
            effective_from: '2026-01-01',
            effective_to: '2026-03-31',
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
        action: 'shift_start',
        effective_date: '2026-04-01',
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    const data = (res.payload as { data: { employees_updated: number; employees_matched: number } }).data;
    expect(data.employees_matched).toBe(2);
    expect(data.employees_updated).toBe(1); // emp 999 без открытого — пропущен

    // 1) DELETE промежуточной записи between
    const deleteBetween = pgExecute.mock.calls.find(([sql, params]) =>
      typeof sql === 'string'
      && sql.toLowerCase().startsWith('delete from employee_schedule_assignments')
      && Array.isArray(params)
      && (params as unknown[]).includes('between'));
    expect(deleteBetween).toBeTruthy();

    // 2) UPDATE closed-old SET effective_to = 2026-03-31 (prev(2026-04-01))
    const closeOld = pgExecute.mock.calls.find(([sql, params]) =>
      typeof sql === 'string'
      && sql.toLowerCase().includes('update employee_schedule_assignments')
      && sql.toLowerCase().includes('set effective_to')
      && Array.isArray(params)
      && (params as unknown[]).includes('closed-old')
      && (params as unknown[]).includes('2026-03-31'));
    expect(closeOld).toBeTruthy();

    // 3) UPDATE open SET effective_from = 2026-04-01
    const shiftOpen = pgExecute.mock.calls.find(([sql, params]) =>
      typeof sql === 'string'
      && sql.toLowerCase().includes('update employee_schedule_assignments')
      && sql.toLowerCase().includes('set effective_from')
      && Array.isArray(params)
      && (params as unknown[]).includes('open')
      && (params as unknown[]).includes('2026-04-01'));
    expect(shiftOpen).toBeTruthy();
  });

  // shift_start с новой датой, которая >= effective_from открытого назначения — no-op
  // для этого сотрудника (employees_updated не растёт, никаких UPDATE/DELETE).
  it('shift_start no-op, если новая дата не раньше текущей effective_from открытого', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from org_departments')) {
        return [{ id: BRIGADE_1, name: 'Бр. 1', kind: 'brigade' }];
      }
      if (lower.includes('from employees')) {
        return [{ id: 92 }];
      }
      if (lower.includes('from employee_schedule_assignments')) {
        return [
          {
            id: 'open',
            employee_id: 92,
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
        action: 'shift_start',
        effective_date: '2026-05-01', // позже текущего effective_from
      },
    });
    const res = makeRes();

    await scheduleController.bulkApplyToBrigades(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { employees_updated: number } }).data.employees_updated).toBe(0);
    // Никаких мутаций
    expect(pgExecute).not.toHaveBeenCalled();
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

describe('scheduleController.fixEmployeeAssignment', () => {
  const ASSIGN_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const ASSIGN_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';
  const ASSIGN_P = 'cccccccc-3333-4333-a333-cccccccccccc';
  const MISSING = 'dddddddd-4444-4444-b444-dddddddddddd';

  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    installDefaultTx();
    mockedState.scope = 'all';
  });

  const findUpdate = (predicate: (sql: string, params: unknown[]) => boolean) =>
    pgExecute.mock.calls.find(([sql, params]) =>
      typeof sql === 'string'
      && sql.toLowerCase().includes('update employee_schedule_assignments')
      && Array.isArray(params)
      && predicate(sql.toLowerCase(), params as unknown[]),
    );

  it('правит только anchor_date той же записи (id не меняется, без INSERT)', async () => {
    pgQuery.mockResolvedValue([
      { id: ASSIGN_A, schedule_id: SCHEDULE_ID, effective_from: '2026-01-01', effective_to: null },
    ]);
    pgExecute.mockResolvedValue(1);
    pgQueryOne.mockResolvedValue({ id: ASSIGN_A, anchor_date: '2026-02-01' });

    const req = makeReq({
      params: { employeeId: '7' },
      body: { assignment_id: ASSIGN_A, anchor_date: '2026-02-01' },
    });
    const res = makeRes();

    await scheduleController.fixEmployeeAssignment(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { id: string } }).data.id).toBe(ASSIGN_A);

    const upd = findUpdate((sql, params) =>
      sql.includes('anchor_date') && params.includes('2026-02-01') && params.includes(ASSIGN_A));
    expect(upd).toBeTruthy();
    expect(upd?.[0]).not.toMatch(/effective_from\s*=/i);

    const insertCalls = pgQueryOne.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.toLowerCase().startsWith('insert'));
    expect(insertCalls).toHaveLength(0);
  });

  it('anchor_date: null очищает override', async () => {
    pgQuery.mockResolvedValue([
      { id: ASSIGN_A, schedule_id: SCHEDULE_ID, effective_from: '2026-01-01', effective_to: null },
    ]);
    pgExecute.mockResolvedValue(1);
    pgQueryOne.mockResolvedValue({ id: ASSIGN_A, anchor_date: null });

    const req = makeReq({
      params: { employeeId: '7' },
      body: { assignment_id: ASSIGN_A, anchor_date: null },
    });
    const res = makeRes();

    await scheduleController.fixEmployeeAssignment(req, res);

    expect(res.statusCode).toBe(200);
    const upd = findUpdate((sql, params) =>
      sql.includes('anchor_date') && params.includes(null) && params.includes(ASSIGN_A));
    expect(upd).toBeTruthy();
  });

  it('правка effective_from подгоняет effective_to предыдущей записи', async () => {
    pgQuery.mockResolvedValue([
      { id: ASSIGN_P, schedule_id: SCHEDULE_ID, effective_from: '2026-01-01', effective_to: '2026-02-28' },
      { id: ASSIGN_A, schedule_id: SCHEDULE_ID, effective_from: '2026-03-01', effective_to: null },
    ]);
    pgExecute.mockResolvedValue(1);
    pgQueryOne.mockResolvedValue({ id: ASSIGN_A, effective_from: '2026-02-15' });

    const req = makeReq({
      params: { employeeId: '7' },
      body: { assignment_id: ASSIGN_A, effective_from: '2026-02-15' },
    });
    const res = makeRes();

    await scheduleController.fixEmployeeAssignment(req, res);

    expect(res.statusCode).toBe(200);

    const prevClosure = findUpdate((sql, params) =>
      sql.includes('set effective_to') && params.includes(ASSIGN_P) && params.includes('2026-02-14'));
    expect(prevClosure).toBeTruthy();

    const targetUpdate = findUpdate((sql, params) =>
      sql.includes('effective_from =') && params.includes('2026-02-15') && params.includes(ASSIGN_A));
    expect(targetUpdate).toBeTruthy();
  });

  it('коллизия effective_from с другой записью → 400, без записи в БД', async () => {
    pgQuery.mockResolvedValue([
      { id: ASSIGN_A, schedule_id: SCHEDULE_ID, effective_from: '2026-03-01', effective_to: null },
      { id: ASSIGN_B, schedule_id: SCHEDULE_ID, effective_from: '2026-05-01', effective_to: null },
    ]);

    const req = makeReq({
      params: { employeeId: '7' },
      body: { assignment_id: ASSIGN_A, effective_from: '2026-05-01' },
    });
    const res = makeRes();

    await scheduleController.fixEmployeeAssignment(req, res);

    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: string }).error).toContain('уже есть назначение');
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('назначение не принадлежит сотруднику → 400 not-found', async () => {
    pgQuery.mockResolvedValue([
      { id: ASSIGN_A, schedule_id: SCHEDULE_ID, effective_from: '2026-01-01', effective_to: null },
    ]);

    const req = makeReq({
      params: { employeeId: '7' },
      body: { assignment_id: MISSING, anchor_date: '2026-02-01' },
    });
    const res = makeRes();

    await scheduleController.fixEmployeeAssignment(req, res);

    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: string }).error).toContain('не найдено');
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('пустое тело (ни одной даты) → 400 ещё до БД', async () => {
    const req = makeReq({
      params: { employeeId: '7' },
      body: { assignment_id: ASSIGN_A },
    });
    const res = makeRes();

    await scheduleController.fixEmployeeAssignment(req, res);

    expect(res.statusCode).toBe(400);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('scheduleController.assignEmployee — коррекция даты на более раннюю', () => {
  const ASSIGN_X = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    installDefaultTx();
    mockedState.scope = 'all';
  });

  it('ранняя дата того же графика двигает effective_from существующей записи in-place (без INSERT)', async () => {
    // Одна активная запись от 2026-05-01. Пользователь ставит более раннюю
    // дату 2026-03-01 тем же графиком → запись должна сдвинуться, а не
    // породить мёртвый отрезок + остаться со старой датой.
    pgQuery.mockResolvedValue([
      { id: ASSIGN_X, schedule_id: SCHEDULE_ID, effective_from: '2026-05-01', effective_to: null },
    ]);
    pgExecute.mockResolvedValue(1);
    pgQueryOne.mockResolvedValue({ id: ASSIGN_X, effective_from: '2026-03-01' });

    const req = makeReq({
      params: { employeeId: '7' },
      body: { schedule_id: SCHEDULE_ID, effective_from: '2026-03-01' },
    });
    const res = makeRes();

    await scheduleController.assignEmployee(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { id: string } }).data.id).toBe(ASSIGN_X);

    // UPDATE сдвига effective_from существующей записи.
    const shift = pgExecute.mock.calls.find(([sql, params]) =>
      typeof sql === 'string'
      && sql.toLowerCase().includes('update employee_schedule_assignments')
      && /effective_from\s*=/i.test(sql)
      && Array.isArray(params)
      && (params as unknown[]).includes('2026-03-01')
      && (params as unknown[]).includes(ASSIGN_X));
    expect(shift).toBeTruthy();

    // Никакого INSERT мёртвого отрезка.
    const inserts = pgQueryOne.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.toLowerCase().trimStart().startsWith('insert'));
    expect(inserts).toHaveLength(0);
  });

  it('массово по бригаде: ранняя дата того же графика двигает существующую запись, новым — INSERT', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from org_departments')) {
        return [{ id: BRIGADE_1, name: 'Бр. 1', kind: 'brigade' }];
      }
      if (lower.includes('from employees')) {
        return [{ id: 401 }, { id: 402 }];
      }
      if (lower.includes('from employee_schedule_assignments')) {
        // 402 уже на том же графике, но запись начинается позже выбранной даты.
        return [
          { id: 'existing-402', employee_id: 402, schedule_id: SCHEDULE_ID, effective_from: '2026-06-01', effective_to: null },
        ];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    let insertCounter = 0;
    pgQueryOne.mockImplementation(async (sql: string) => {
      if (sql.toLowerCase().trimStart().startsWith('insert into employee_schedule_assignments')) {
        insertCounter += 1;
        return { id: `new-${insertCounter}` };
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
    expect(data.employees_matched).toBe(2);
    expect(data.employees_updated).toBe(2);
    expect(data.employees_failed).toBe(0);

    // 402: сдвиг existing-402 на 2026-04-20 (без INSERT для него).
    const shift = pgExecute.mock.calls.find(([sql, params]) =>
      typeof sql === 'string'
      && sql.toLowerCase().includes('update employee_schedule_assignments')
      && /effective_from\s*=/i.test(sql)
      && Array.isArray(params)
      && (params as unknown[]).includes('2026-04-20')
      && (params as unknown[]).includes('existing-402'));
    expect(shift).toBeTruthy();

    // 401: новый сотрудник → ровно один INSERT.
    const inserts = pgQueryOne.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.toLowerCase().trimStart().startsWith('insert into employee_schedule_assignments'));
    expect(inserts).toHaveLength(1);
  });
});
