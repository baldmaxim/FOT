import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Контроллер выгрузки сотрудников: охват по скоупу (без фильтров экрана),
 * единый период для уволенных и объектов, строгий аудит до отдачи файла.
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
  queryOne: vi.fn(),
  withTransaction: withTransactionMock,
}));

const auditMock = vi.hoisted(() => vi.fn());

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequestWithClient: auditMock },
}));

const mainObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../services/employee-main-object-snapshot.service.js', () => ({
  loadMainObjects: mainObjectMock,
}));

const costItemsMock = vi.hoisted(() => vi.fn());
vi.mock('../services/employee-cost-item.service.js', () => ({
  loadCostItems: costItemsMock,
}));

const SNAPSHOT_PERIOD = { start: '2026-08-15', end: '2026-09-13' };

const { employeesExportController, resolveExportPeriod } = await import('./employees-export.controller.js');
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

const employeeRow = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  full_name: `Сотрудник ${id}`,
  employment_status: 'active',
  birth_date: '1990-03-05',
  hire_date: '2024-01-15',
  position_name: 'Монтажник',
  effective_department_id: 'd1',
  in_department_scope: true,
  ...overrides,
});

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
    if (String(sql).includes('FROM employees')) return [employeeRow(1)];
    return [{ id: 'd1', parent_id: null, name: 'Отдел', kind: 'department' }];
  });
  mainObjectMock.mockResolvedValue({
    period: SNAPSHOT_PERIOD,
    objects: new Map([[1, 'ЖК Север']]),
    objectNamesByEmployee: new Map([[1, ['ЖК Север', 'ЖК Юг']]]),
    source: 'snapshot',
  });
  costItemsMock.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, 'СКУД (ЖК Север, ЖК Юг)'])));
  withTransactionMock.mockImplementation(async (fn: (client: unknown) => Promise<void>) => fn({}));
});

describe('resolveExportPeriod', () => {
  it('ровно 30 дат включительно, по московскому календарю', () => {
    // 21:30 UTC 13.09 — в Москве уже 14.09.
    const period = resolveExportPeriod(new Date('2026-09-13T21:30:00Z'));
    expect(period).toEqual({ start: '2026-08-16', end: '2026-09-14' });
  });

  it('переход через границу года', () => {
    expect(resolveExportPeriod(new Date('2026-01-10T12:00:00Z')))
      .toEqual({ start: '2025-12-12', end: '2026-01-10' });
  });
});

describe('employeesExportController.exportEmployees', () => {
  it('scope=all — без предиката по отделам, фильтр увольнения по периоду, все в скоупе отделов', async () => {
    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    const [sql, params] = employeeCalls()[0];
    expect(sql).not.toContain('effective_department_id = ANY');
    expect(sql).toContain(`e.dismissal_date BETWEEN $1::date AND $2::date`);
    expect(sql).not.toContain('current_date');
    expect(sql).toContain('TRUE AS in_department_scope');
    expect(params.slice(0, 2)).toEqual([expect.any(String), expect.any(String)]);
    expect(res.statusCode).toBe(200);
  });

  it('объекты берутся из снимка; период выборки передаётся как запасной для расчёта на лету', async () => {
    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    const [, params] = employeeCalls()[0];
    const [ids, livePeriod] = mainObjectMock.mock.calls[0];
    expect(ids).toEqual([1]);
    expect(livePeriod).toEqual({ start: params[0], end: params[1] });
    expect(res.statusCode).toBe(200);
  });

  it('в файле период объекта — из снимка, период уволенных — из выборки', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sent as ArrayBuffer);
    const meta = String(workbook.worksheets[0].getCell(2, 1).value);
    expect(meta).toContain('объект — где больше всего часов за 15.08.2026–13.09.2026');
    expect(meta).toMatch(/уволенные — за \d{2}\.\d{2}\.\d{4}–\d{2}\.\d{2}\.\d{4}/);
  });

  it('«Статья затрат» — из loadCostItems по тем же id и спискам объектов, что у таблицы', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    expect(costItemsMock).toHaveBeenCalledWith([1], new Map([[1, ['ЖК Север', 'ЖК Юг']]]));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sent as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.getCell(3, 9).value).toBe('Статья затрат');
    expect(sheet.getCell(4, 9).value).toBe('СКУД (ЖК Север, ЖК Юг)');
  });

  it('scope=department — отделы и подчинённые в одних скобках после фильтра статуса', async () => {
    scope.dataScope = 'department';
    scope.managedDepartmentIds = ['d1', 'd2'];
    scope.directSubordinates = [77];

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    const [sql, params] = employeeCalls()[0];
    expect(sql).toMatch(
      /WHERE \(\(b\.effective_department_id IS NOT NULL AND b\.effective_department_id = ANY\(\$3::uuid\[\]\)\) OR b\.id = ANY\(\$4::int\[\]\)\)/,
    );
    expect(params[2]).toEqual(['d1', 'd2']);
    // Сам руководитель добавлен: у него есть прямые подчинённые.
    expect(params[3]).toEqual([77, 10]);
  });

  it('department-scope без explicit-назначений и подчинённых — сам пользователь не добавляется', async () => {
    scope.dataScope = 'department';
    scope.managedDepartmentIds = ['d1'];

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    const [sql, params] = employeeCalls()[0];
    expect(sql).not.toContain('b.id = ANY');
    expect(params.slice(2)).toEqual([['d1'], 50001]);
  });

  it('scope=self без employee_id — 400 и тяжёлые запросы не выполняются', async () => {
    scope.dataScope = 'self';

    const res = makeRes();
    await employeesExportController.exportEmployees(req(null), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_DATA' });
    expect(employeeCalls()).toHaveLength(0);
    expect(mainObjectMock).not.toHaveBeenCalled();
  });

  it('пустая выборка — 400 NO_DATA, объекты не считаются', async () => {
    queryMock.mockImplementation(async () => []);

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_DATA' });
    expect(mainObjectMock).not.toHaveBeenCalled();
  });

  it('успех — xlsx-заголовки, имя файла в UTF-8 и запись аудита с разделами и периодом', async () => {
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
    expect(options).toMatchObject({
      details: {
        count: 1,
        sections: { other: 1 },
        scope: 'all',
        period: mainObjectMock.mock.calls[0][1],
        object_period: SNAPSHOT_PERIOD,
        object_source: 'snapshot',
      },
    });
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
        return Array.from({ length: MAX_EXPORT_EMPLOYEES + 1 }, (_, index) => employeeRow(index + 1));
      }
      return [];
    });

    const res = makeRes();
    await employeesExportController.exportEmployees(req(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(res.sent).toBeUndefined();
  });
});
