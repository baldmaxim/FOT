import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Контроллер выгрузки сотрудников: охват по скоупу (без фильтров экрана),
 * строгий аудит до отдачи файла и явные 400 вместо общего 500.
 */

const scope = vi.hoisted(() => ({
  dataScope: 'all' as 'self' | 'department' | 'all',
  managedDepartmentIds: [] as string[],
  scopedDepartmentId: null as string | null,
  explicitDepartmentIds: [] as string[],
  directSubordinates: [] as number[],
}));

vi.mock('../services/data-scope.service.js', () => ({
  resolveRequestDataScopeWithDirectReports: vi.fn(async () => scope.dataScope),
  resolveManagedDepartmentIds: vi.fn(async () => scope.managedDepartmentIds),
  resolveScopedDepartmentId: vi.fn(async () => scope.scopedDepartmentId),
}));

vi.mock('../services/department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: vi.fn(async () => scope.explicitDepartmentIds),
}));

vi.mock('../services/employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => scope.directSubordinates),
}));

vi.mock('../services/skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (id: string) => [id]),
}));

const queryMock = vi.hoisted(() => vi.fn());
const withTransactionMock = vi.hoisted(() => vi.fn());

vi.mock('../config/postgres.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
}));

const auditMock = vi.hoisted(() => vi.fn());

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequestWithClient: auditMock },
}));

const { employeesExportController } = await import('./employees-export.controller.js');
const { MAX_EXPORT_EMPLOYEES } = await import('../services/employees-export.service.js');

type MockResponse = Response & {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  sent: unknown;
};

function makeRes(): MockResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    sent: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
    setHeader(name: string, value: string) { res.headers[name] = value; return res; },
    send(payload: unknown) { res.sent = payload; return res; },
  };
  return res as unknown as MockResponse;
}

const req = (employeeId: number | null = 10): AuthenticatedRequest => ({
  user: { id: 'user-1', employee_id: employeeId },
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
  headers: {},
} as unknown as AuthenticatedRequest);

/** SQL-вызовы к таблице employees (второй запрос — за отделами). */
const employeeCalls = (): Array<[string, unknown[]]> =>
  queryMock.mock.calls.filter(call => String(call[0]).includes('FROM employees')) as Array<[string, unknown[]]>;

beforeEach(() => {
  vi.clearAllMocks();
  scope.dataScope = 'all';
  scope.managedDepartmentIds = [];
  scope.scopedDepartmentId = null;
  scope.explicitDepartmentIds = [];
  scope.directSubordinates = [];

  queryMock.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM employees')) {
      return [{ id: 1, full_name: 'Петров П. П.', org_department_id: 'd1' }];
    }
    return [{ id: 'd1', parent_id: null, name: 'Отдел', sort_order: 0 }];
  });
  withTransactionMock.mockImplementation(async (fn: (client: unknown) => Promise<void>) => fn({}));
});

describe('employeesExportController.exportEmployees', () => {
  it('scope=all — в запросе нет предиката по отделам', async () => {
    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    const [sql] = employeeCalls()[0];
    expect(sql).not.toContain('org_department_id = ANY');
    expect(sql).toContain(`employment_status <> 'fired'`);
    expect(sql).toContain('is_archived = false');
    expect(res.statusCode).toBe(200);
  });

  it('scope=department — фильтр по отделам и по прямым подчинённым', async () => {
    scope.dataScope = 'department';
    scope.managedDepartmentIds = ['d1', 'd2'];
    scope.directSubordinates = [77];

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    const [sql, params] = employeeCalls()[0];
    expect(sql).toContain('org_department_id = ANY');
    expect(sql).toContain('id = ANY');
    expect(params[0]).toEqual(['d1', 'd2']);
    // Сам руководитель добавлен: у него есть прямые подчинённые.
    expect(params[1]).toEqual([77, 10]);
  });

  it('department-scope без explicit-назначений и подчинённых — сам пользователь не добавляется', async () => {
    scope.dataScope = 'department';
    scope.managedDepartmentIds = ['d1'];
    scope.explicitDepartmentIds = [];
    scope.directSubordinates = [];

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    const [sql, params] = employeeCalls()[0];
    expect(sql).not.toContain('OR id = ANY');
    // Параметры: только отделы и LIMIT — списка сотрудников нет.
    expect(params).toEqual([['d1'], 50001]);
  });

  it('scope=self без employee_id — 400 и тяжёлый запрос не выполняется', async () => {
    scope.dataScope = 'self';

    const res = makeRes();
    await employeesExportController.exportEmployees(req(null), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_DATA' });
    expect(employeeCalls()).toHaveLength(0);
  });

  it('department-scope без отделов и подчинённых — 400 и ни одного запроса к employees', async () => {
    scope.dataScope = 'department';
    scope.managedDepartmentIds = [];
    scope.scopedDepartmentId = null;

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_DATA' });
    expect(employeeCalls()).toHaveLength(0);
  });

  it('успех — xlsx-заголовки, имя файла в UTF-8 и запись аудита', async () => {
    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    expect(res.headers['Content-Type'])
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['Content-Disposition']).toContain(`filename*=UTF-8''`);
    expect(Buffer.isBuffer(res.sent)).toBe(true);

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [, , userId, action, options] = auditMock.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(action).toBe('EXPORT_EMPLOYEES');
    expect(options).toMatchObject({ details: { count: 1 } });
  });

  it('сбой записи аудита — 500 и файл не отдан', async () => {
    withTransactionMock.mockRejectedValueOnce(new Error('audit_logs недоступна'));

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    expect(res.statusCode).toBe(500);
    expect(res.sent).toBeUndefined();
    expect(res.headers['Content-Disposition']).toBeUndefined();
  });

  it('превышение лимита строк — 400 EXPORT_TOO_LARGE', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM employees')) {
        return Array.from({ length: MAX_EXPORT_EMPLOYEES + 1 }, (_, index) => ({
          id: index + 1,
          full_name: `Сотрудник ${index + 1}`,
          org_department_id: 'd1',
        }));
      }
      return [{ id: 'd1', parent_id: null, name: 'Отдел', sort_order: 0 }];
    });

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(res.sent).toBeUndefined();
  });
});
