import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  withTransaction: pgTx,
}));

const scope = vi.hoisted(() => ({
  canAccessDepartmentInScope: vi.fn(async () => true),
  canAccessEmployeeInScope: vi.fn(async () => true),
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all' as const),
}));

vi.mock('../services/data-scope.service.js', () => scope);

const { contractorRootMock } = vi.hoisted(() => ({ contractorRootMock: vi.fn() }));
vi.mock('../config/contractor.js', () => ({ getContractorRootId: contractorRootMock }));

const audit = vi.hoisted(() => ({ logFromRequestWithClient: vi.fn(async () => {}) }));
vi.mock('../services/audit.service.js', () => ({
  auditService: audit,
  AUDIT_ACTIONS: {
    TIMESHEET_MODE_UPDATED: 'TIMESHEET_MODE_UPDATED',
    TIMESHEET_MODE_BULK_UPDATED: 'TIMESHEET_MODE_BULK_UPDATED',
  },
}));

import { timesheetModeController } from './timesheet-mode.controller.js';

const DEPT = '11111111-1111-1111-1111-111111111111';
const OBJ = '22222222-2222-2222-2222-222222222222';
const CONTRACTOR_ROOT = '44444444-4444-4444-4444-444444444444';

function makeReq(overrides: Partial<AuthenticatedRequest>): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    user: { id: 'user-1' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function makeRes(): Response & { statusCode: number; payload: unknown } {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

/** Клиент транзакции: собирает выполненные запросы, отдаёт заготовленные ответы. */
function makeTxClient(responses: Array<{ rows: unknown[]; rowCount: number }>) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    client: {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
        const next = responses[i];
        i += 1;
        return next ?? { rows: [], rowCount: 1 };
      }),
    },
  };
}

beforeEach(() => {
  pgQuery.mockReset();
  pgQueryOne.mockReset();
  pgTx.mockReset();
  audit.logFromRequestWithClient.mockClear();
  scope.canAccessDepartmentInScope.mockReset().mockResolvedValue(true);
  scope.canAccessEmployeeInScope.mockReset().mockResolvedValue(true);
  scope.resolveAccessibleDepartmentIds.mockReset().mockResolvedValue('all');
  contractorRootMock.mockReset().mockResolvedValue(CONTRACTOR_ROOT);
});

describe('timesheetModeController.list — скоуп', () => {
  it('чужой отдел не отдаётся даже на read-only запросе', async () => {
    scope.canAccessDepartmentInScope.mockResolvedValue(false);
    const res = makeRes();

    await timesheetModeController.list(makeReq({ query: { department_id: DEPT } }), res);

    expect(res.statusCode).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('без department_id и employee_ids — 400', async () => {
    const res = makeRes();
    await timesheetModeController.list(makeReq({ query: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('выборка по employee_ids работает без department_id', async () => {
    pgQuery.mockResolvedValueOnce([
      {
        employee_id: 7, full_name: 'Есенов Максим Николаевич', org_department_id: DEPT,
        emp_mode: 'skud', emp_object_id: null, dept_mode: null, dept_object_id: null,
        dept_current_activity: true,
      },
    ]);

    const res = makeRes();
    await timesheetModeController.list(makeReq({ query: { employee_ids: '7' } }), res);

    expect(res.statusCode).toBe(200);
    const payload = (res.payload as { data: { department: { id: string | null }; employees: Array<{ effective_mode: string; source: string }> } }).data;
    // Режим отдела не запрашивался — выборка не по отделу.
    expect(payload.department.id).toBeNull();
    expect(pgQueryOne).not.toHaveBeenCalled();
    // Явный skud перекрывает legacy-ТД отдела.
    expect(payload.employees[0].effective_mode).toBe('skud');
    expect(payload.employees[0].source).toBe('employee_explicit');
  });

  it('выборка по employee_ids отсекает сотрудников вне скоупа', async () => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue([DEPT]);
    pgQuery.mockResolvedValueOnce([
      {
        employee_id: 7, full_name: 'Свой', org_department_id: DEPT,
        emp_mode: null, emp_object_id: null, dept_mode: null, dept_object_id: null,
        dept_current_activity: false,
      },
      {
        employee_id: 8, full_name: 'Чужой', org_department_id: 'other-dept',
        emp_mode: null, emp_object_id: null, dept_mode: null, dept_object_id: null,
        dept_current_activity: false,
      },
    ]);

    const res = makeRes();
    await timesheetModeController.list(makeReq({ query: { employee_ids: '7,8' } }), res);

    const payload = (res.payload as { data: { employees: Array<{ full_name: string }> } }).data;
    expect(payload.employees.map(e => e.full_name)).toEqual(['Свой']);
  });

  it('сотрудники вне доступного поддерева отфильтровываются', async () => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue([DEPT]);
    pgQuery.mockResolvedValueOnce([
      {
        employee_id: 1, full_name: 'Свой Сотрудник', org_department_id: DEPT,
        emp_mode: null, emp_object_id: null, dept_mode: null, dept_object_id: null,
        dept_current_activity: false,
      },
      {
        employee_id: 2, full_name: 'Чужой Сотрудник', org_department_id: 'other-dept',
        emp_mode: null, emp_object_id: null, dept_mode: null, dept_object_id: null,
        dept_current_activity: false,
      },
    ]);
    pgQueryOne.mockResolvedValueOnce({ timesheet_export_mode: null, timesheet_export_object_id: null });

    const res = makeRes();
    await timesheetModeController.list(makeReq({ query: { department_id: DEPT } }), res);

    const payload = (res.payload as { data: { employees: Array<{ full_name: string; source: string }> } }).data;
    expect(payload.employees).toHaveLength(1);
    expect(payload.employees[0].full_name).toBe('Свой Сотрудник');
    // Режим не задан и legacy-признаков нет → skud из legacy_default.
    expect(payload.employees[0].source).toBe('legacy_default');
  });

  // Миграция 253: персональные назначения объектов из резолвинга убраны — это доступ
  // табельщицы, а не режим выгрузки. Раньше здесь возвращался source = legacy_employee.
  it('персональные назначения объектов в резолвинге не участвуют', async () => {
    pgQuery.mockResolvedValueOnce([
      {
        employee_id: 1, full_name: 'Иванов', org_department_id: DEPT,
        emp_mode: null, emp_object_id: null, dept_mode: null, dept_object_id: null,
        dept_current_activity: true,
      },
    ]);
    pgQueryOne.mockResolvedValueOnce({ timesheet_export_mode: null, timesheet_export_object_id: null });

    const res = makeRes();
    await timesheetModeController.list(makeReq({ query: { department_id: DEPT } }), res);

    const payload = (res.payload as { data: { employees: Array<{ source: string; effective_mode: string }> } }).data;
    // Решают только объекты отдела.
    expect(payload.employees[0].source).toBe('legacy_department');
    expect(payload.employees[0].effective_mode).toBe('current_activity');
    // Таблица назначений в запрос больше не входит — иначе связь вернулась бы незаметно.
    expect(String(pgQuery.mock.calls[0][0])).not.toContain('employee_object_assignment');
  });
});

describe('timesheetModeController.updateEmployee — валидация и скоуп', () => {
  it('режим object без object_id отклоняется', async () => {
    const res = makeRes();
    await timesheetModeController.updateEmployee(
      makeReq({ params: { id: '5' }, body: { mode: 'object', object_id: null } }), res,
    );
    expect(res.statusCode).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('неактивный объект отклоняется на запись', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: OBJ, is_active: false });
    const res = makeRes();
    await timesheetModeController.updateEmployee(
      makeReq({ params: { id: '5' }, body: { mode: 'object', object_id: OBJ } }), res,
    );
    expect(res.statusCode).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('object_id при режиме skud обнуляется, а не пишется', async () => {
    const { client, calls } = makeTxClient([
      { rows: [{ timesheet_export_mode: null, timesheet_export_object_id: null, full_name: 'Иванов' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    pgTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const res = makeRes();
    await timesheetModeController.updateEmployee(
      makeReq({ params: { id: '5' }, body: { mode: 'skud', object_id: OBJ } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { object_id: string | null } }).data.object_id).toBeNull();
    // Блокировка берётся до чтения строки.
    expect(calls[0]).toContain('pg_advisory_xact_lock');
    expect(calls[1]).toContain('FOR UPDATE');
  });

  it('чужой сотрудник — 403 без записи', async () => {
    scope.canAccessEmployeeInScope.mockResolvedValue(false);
    const res = makeRes();
    await timesheetModeController.updateEmployee(
      makeReq({ params: { id: '5' }, body: { mode: 'skud' } }), res,
    );
    expect(res.statusCode).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('mode: null сбрасывает режим (возврат к legacy)', async () => {
    const { client } = makeTxClient([
      { rows: [{ timesheet_export_mode: 'skud', timesheet_export_object_id: null, full_name: 'Иванов' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    pgTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const res = makeRes();
    await timesheetModeController.updateEmployee(
      makeReq({ params: { id: '5' }, body: { mode: null } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { mode: string | null } }).data.mode).toBeNull();
    // Аудит содержит и старое, и новое значение.
    const details = audit.logFromRequestWithClient.mock.calls[0][4] as { details: Record<string, unknown> };
    expect(details.details.old_mode).toBe('skud');
    expect(details.details.new_mode).toBeNull();
  });
});

describe('timesheetModeController.updateDepartment — поддерево', () => {
  it('apply_to_subtree проверяет доступ к каждому потомку', async () => {
    pgQuery.mockResolvedValueOnce([{ id: DEPT }, { id: 'child-1' }]);
    scope.canAccessDepartmentInScope
      .mockResolvedValueOnce(true)   // сам отдел
      .mockResolvedValueOnce(true)   // DEPT в цикле
      .mockResolvedValueOnce(false); // child-1 вне доступа

    const res = makeRes();
    await timesheetModeController.updateDepartment(
      makeReq({ params: { id: DEPT }, body: { mode: 'skud', apply_to_subtree: true } }), res,
    );

    expect(res.statusCode).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('без apply_to_subtree пишется только сам отдел', async () => {
    const { client } = makeTxClient([
      { rows: [{ id: DEPT, name: 'Отдел', timesheet_export_mode: null, timesheet_export_object_id: null }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    pgTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const res = makeRes();
    await timesheetModeController.updateDepartment(
      makeReq({ params: { id: DEPT }, body: { mode: 'skud' } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { affected: number } }).data.affected).toBe(1);
    // Дерево не разворачивалось.
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('timesheetModeController — массовая настройка подразделений', () => {
  const DEPT2 = '33333333-3333-3333-3333-333333333333';

  it('listDepartments отдаёт effective_mode и не показывает отделы вне скоупа', async () => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue([DEPT]);
    pgQuery.mockResolvedValueOnce([
      {
        id: DEPT, name: 'Геодезическая служба', kind: 'department',
        mode: null, object_id: null, object_name: null, object_is_active: null,
        dept_current_activity: true,
      },
      {
        id: DEPT2, name: 'Чужой отдел', kind: 'department',
        mode: null, object_id: null, object_name: null, object_is_active: null,
        dept_current_activity: false,
      },
    ]);

    const res = makeRes();
    await timesheetModeController.listDepartments(makeReq({}), res);

    const payload = (res.payload as { data: { departments: Array<{ name: string; effective_mode: string; source: string }> } }).data;
    expect(payload.departments).toHaveLength(1);
    // Режим не задан, но ТД-назначение есть → фактически действует «текущая деятельность».
    expect(payload.departments[0].effective_mode).toBe('current_activity');
    expect(payload.departments[0].source).toBe('legacy_department');
  });

  it('listDepartments размечает ветку подрядчиков и раскрывает поддерево в SQL', async () => {
    pgQuery.mockResolvedValueOnce([
      {
        id: DEPT, name: 'Геодезическая служба', kind: 'department',
        mode: null, object_id: null, object_name: null, object_is_active: null,
        dept_current_activity: false, is_contractor: false,
      },
      {
        id: DEPT2, name: 'ВОЛЬТЕКС ООО', kind: 'department',
        mode: null, object_id: null, object_name: null, object_is_active: null,
        dept_current_activity: false, is_contractor: true,
      },
    ]);

    const res = makeRes();
    await timesheetModeController.listDepartments(makeReq({}), res);

    expect(contractorRootMock).toHaveBeenCalled();
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    // Поддерево считает сама БД: имя корня в SQL не зашито, приходит параметром.
    expect(sql).toContain('get_descendant_department_ids');
    expect(params[1]).toEqual([CONTRACTOR_ROOT]);

    const departments = (res.payload as { data: { departments: Array<{ name: string; is_contractor: boolean }> } })
      .data.departments;
    expect(departments.map(d => [d.name, d.is_contractor])).toEqual([
      ['Геодезическая служба', false],
      ['ВОЛЬТЕКС ООО', true],
    ]);
  });

  it('listDepartments: корень подрядчиков не синхронизирован — пустой массив, запрос не падает', async () => {
    contractorRootMock.mockResolvedValue(null);
    pgQuery.mockResolvedValueOnce([
      {
        id: DEPT, name: 'Геодезическая служба', kind: 'department',
        mode: null, object_id: null, object_name: null, object_is_active: null,
        dept_current_activity: false, is_contractor: false,
      },
    ]);

    const res = makeRes();
    await timesheetModeController.listDepartments(makeReq({}), res);

    expect(res.statusCode).toBe(200);
    // Пустой uuid[] → ноль потомков → флаг не проставится никому.
    expect((pgQuery.mock.calls[0] as [string, unknown[]])[1][1]).toEqual([]);
  });

  it('bulk: чужое подразделение в списке — 403 и ни одной записи', async () => {
    pgQuery.mockResolvedValueOnce([
      { id: DEPT, kind: 'department' },
      { id: DEPT2, kind: 'brigade' },
    ]);
    scope.canAccessDepartmentInScope
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const res = makeRes();
    await timesheetModeController.updateDepartmentsBulk(
      makeReq({ body: { department_ids: [DEPT, DEPT2], mode: 'skud' } }), res,
    );

    expect(res.statusCode).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('bulk: несуществующее подразделение — 400 без записи', async () => {
    pgQuery.mockResolvedValueOnce([{ id: DEPT, kind: 'department' }]);

    const res = makeRes();
    await timesheetModeController.updateDepartmentsBulk(
      makeReq({ body: { department_ids: [DEPT, DEPT2], mode: 'skud' } }), res,
    );

    expect(res.statusCode).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('bulk: узел-объект отклоняется — режим только для отделов и бригад', async () => {
    pgQuery.mockResolvedValueOnce([{ id: DEPT, kind: 'object' }]);

    const res = makeRes();
    await timesheetModeController.updateDepartmentsBulk(
      makeReq({ body: { department_ids: [DEPT], mode: 'skud' } }), res,
    );

    expect(res.statusCode).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('bulk: режим object без объекта — 400', async () => {
    const res = makeRes();
    await timesheetModeController.updateDepartmentsBulk(
      makeReq({ body: { department_ids: [DEPT], mode: 'object', object_id: null } }), res,
    );

    expect(res.statusCode).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('bulk: пакет больше лимита — 400, а не тихая обрезка', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

    const res = makeRes();
    await timesheetModeController.updateDepartmentsBulk(
      makeReq({ body: { department_ids: many, mode: 'skud' } }), res,
    );

    expect(res.statusCode).toBe(400);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('bulk: пишет только org_departments — личные режимы сотрудников не трогает', async () => {
    pgQuery.mockResolvedValueOnce([
      { id: DEPT, kind: 'department' },
      { id: DEPT2, kind: 'brigade' },
    ]);
    const { client, calls } = makeTxClient([
      {
        rows: [
          { id: DEPT, name: 'Отдел', timesheet_export_mode: null, timesheet_export_object_id: null },
          { id: DEPT2, name: 'Бригада', timesheet_export_mode: 'current_activity', timesheet_export_object_id: null },
        ],
        rowCount: 2,
      },
      { rows: [], rowCount: 2 },
    ]);
    pgTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const res = makeRes();
    await timesheetModeController.updateDepartmentsBulk(
      makeReq({ body: { department_ids: [DEPT, DEPT2], mode: 'skud' } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { affected: number } }).data.affected).toBe(2);
    // Ни одного UPDATE по employees: персональные исключения переживают массовую операцию.
    expect(calls.some(sql => sql.includes('UPDATE employees'))).toBe(false);
    expect(calls[0]).toContain('pg_advisory_xact_lock');
    // Аудит содержит старые значения по каждому подразделению.
    const auditArgs = audit.logFromRequestWithClient.mock.calls[0][4] as { details: { affected_departments: unknown[] } };
    expect(auditArgs.details.affected_departments).toHaveLength(2);
    // И ни одного касания привязок объектов: это отдельная сущность (скоуп табельщицы).
    expect(calls.some(sql => sql.includes('object_assignment'))).toBe(false);
  });

  /**
   * Конверт `{ success, data }` — не косметика: клиент читает `response.data` (adminService),
   * и «голый» объект превращался в undefined → пустые списки и «—» в колонке «Объект».
   */
  it('ответы приходят в конверте { success, data }, а не голым объектом', async () => {
    pgQuery.mockResolvedValueOnce([{
      id: DEPT, name: 'Отдел', kind: 'department',
      mode: null, object_id: null, object_name: null, object_is_active: null,
      dept_current_activity: false,
    }]);
    const listRes = makeRes();
    await timesheetModeController.listDepartments(makeReq({}), listRes);

    const listBody = listRes.payload as { success?: boolean; data?: { departments?: unknown[] }; departments?: unknown[] };
    expect(listBody.success).toBe(true);
    expect(listBody.data?.departments).toHaveLength(1);
    // Старая «голая» форма не должна остаться — иначе клиент снова прочитает undefined.
    expect(listBody.departments).toBeUndefined();

    pgQuery.mockResolvedValueOnce([{ id: DEPT, kind: 'department' }]);
    const { client } = makeTxClient([
      { rows: [{ id: DEPT, name: 'Отдел', timesheet_export_mode: null, timesheet_export_object_id: null }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    pgTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const bulkRes = makeRes();
    await timesheetModeController.updateDepartmentsBulk(
      makeReq({ body: { department_ids: [DEPT], mode: 'skud' } }), bulkRes,
    );

    const bulkBody = bulkRes.payload as {
      success?: boolean;
      data?: { affected: number; mode: string | null; object_id: string | null };
      affected?: number;
    };
    expect(bulkBody.success).toBe(true);
    expect(bulkBody.data).toMatchObject({ affected: 1, mode: 'skud', object_id: null });
    expect(bulkBody.affected).toBeUndefined();
  });
});
