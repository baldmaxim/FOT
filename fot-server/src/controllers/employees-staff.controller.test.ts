import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  txQuery: vi.fn(),
  buildStaffBaseFilter: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  saveStaffComment: vi.fn(),
  loadMainObjects: vi.fn(),
  loadActiveSnapshotRun: vi.fn(),
  logWithClient: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  withTransaction: async <T>(fn: (client: { query: typeof h.txQuery }) => Promise<T>) => fn({ query: h.txQuery }),
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { logFromRequestWithClient: h.logWithClient } }));
vi.mock('../services/data-scope.service.js', () => ({ canAccessEmployeeInScope: h.canAccessEmployeeInScope }));
vi.mock('../services/employee-main-object-snapshot.service.js', () => ({
  loadMainObjects: h.loadMainObjects,
  loadActiveSnapshotRun: h.loadActiveSnapshotRun,
}));
vi.mock('../services/employee-staff-comment.service.js', () => ({
  saveStaffComment: h.saveStaffComment,
  STAFF_COMMENT_MAX_LENGTH: 2000,
}));
vi.mock('../services/skud-shared.service.js', () => ({ getAllDepartmentsTree: vi.fn(async () => []) }));
vi.mock('./employees-export.controller.js', () => ({
  resolveExportPeriod: () => ({ start: '2026-08-17', end: '2026-09-15' }),
}));
vi.mock('./employees-staff-filter.helpers.js', async () => {
  const actual = await vi.importActual<typeof import('./employees-staff-filter.helpers.js')>('./employees-staff-filter.helpers.js');
  return { ...actual, buildStaffBaseFilter: h.buildStaffBaseFilter };
});

const { employeesStaffController } = await import('./employees-staff.controller.js');

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    sent: null as Buffer | null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    setHeader(name: string, value: string) { res.headers[name] = value; },
    send(buffer: Buffer) { res.sent = buffer; return res; },
  };
  return res;
};

const makeReq = (query: Record<string, unknown> = {}, extra: Partial<{ params: object; body: unknown }> = {}) => ({
  user: { id: 'u-1', is_admin: false, employee_id: 5 },
  query,
  params: extra.params ?? {},
  body: extra.body ?? {},
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

const baseFilter = () => ({ kind: 'ok', whereParts: ['is_archived = $1'], params: [false], departmentId: null, showArchived: false, search: null });

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.buildStaffBaseFilter.mockImplementation(async () => baseFilter());
  h.logWithClient.mockResolvedValue(undefined);
  h.loadMainObjects.mockResolvedValue({ objects: new Map([[2, '=ЖК Альфа']]), source: 'snapshot' });
  h.loadActiveSnapshotRun.mockResolvedValue({ id: 1 });
});

describe('GET /employees/month-movement', () => {
  it('считает по базе фильтра без статуса и периода; месяц по Москве', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T22:10:00Z')); // в Москве 1 октября
    try {
      h.queryOne.mockResolvedValue({ hired: 3, fired: '7' });
      const res = makeRes();
      await employeesStaffController.getMonthMovement(makeReq({ status: 'fired', period: 'fired_month' }), res as unknown as Response);
      expect(res.body).toEqual({ success: true, data: { month_start: '2026-10-01', today: '2026-10-01', hired: 3, fired: 7 } });
      const [sql, params] = h.queryOne.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(`employment_status <> 'fired'`);
      expect(sql).toContain('hire_date BETWEEN $2::date AND $3::date');
      expect(sql).toContain('dismissal_date BETWEEN $2::date AND $3::date');
      expect(sql).not.toMatch(/WHERE[\s\S]*employment_status = 'fired'\s*$/);
      expect(params).toEqual([false, '2026-10-01', '2026-10-01']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('пустой скоуп — нули; ошибка фильтра — её статус', async () => {
    h.buildStaffBaseFilter.mockResolvedValueOnce({ kind: 'empty' });
    let res = makeRes();
    await employeesStaffController.getMonthMovement(makeReq(), res as unknown as Response);
    expect(res.body).toMatchObject({ data: { hired: 0, fired: 0 } });
    expect(h.queryOne).not.toHaveBeenCalled();

    h.buildStaffBaseFilter.mockResolvedValueOnce({ kind: 'error', status: 403, body: { success: false, error: 'x', code: 'DEPARTMENT_ACCESS_DENIED' } });
    res = makeRes();
    await employeesStaffController.getMonthMovement(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /employees/export-view', () => {
  const rows = [
    { id: 2, full_name: 'Абаев А.', hire_date: '2026-09-01', birth_date: null, department_name: 'Склад', position_name: '+Кладовщик', schedule_name: '5+2', staff_comment: '-проверить', sign: 'Работает' },
    { id: 1, full_name: '@Борисов Б.', hire_date: null, birth_date: '1990-05-17', department_name: null, position_name: null, schedule_name: null, staff_comment: null, sign: 'Уволен' },
  ];

  it('один лист, 10 колонок в порядке экрана, строки в порядке SQL, даты — Excel Date, защита от формул, строгий аудит', async () => {
    h.query.mockResolvedValue(rows);
    const res = makeRes();
    await employeesStaffController.exportView(makeReq({ status: 'fired', sort: 'department', dir: 'desc', section: 'su10', period: 'fired_month' }), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY (s.sort_key IS NULL) ASC, s.sort_key DESC, s.id DESC');
    expect(sql).toContain(`employment_status = 'fired'`);
    expect(sql).toMatch(/dismissal_date BETWEEN/);
    expect(params.at(-1)).toBe(50001);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sent as unknown as ArrayBuffer);
    expect(workbook.worksheets).toHaveLength(1);
    const ws = workbook.worksheets[0];
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual([
      '№', 'ФИО', 'Отдел', 'Должность', 'Дата трудоустройства', 'Дата рождения', 'График', 'Объект', 'Комментарий', 'Признак',
    ]);
    const first = ws.getRow(2);
    expect(first.getCell(1).value).toBe(1);
    expect(first.getCell(2).value).toBe('Абаев А.');
    expect(first.getCell(4).value).toBe("'+Кладовщик");
    expect(first.getCell(5).value).toEqual(new Date(Date.UTC(2026, 8, 1)));
    expect(first.getCell(5).numFmt).toBe('dd.mm.yyyy');
    expect(first.getCell(8).value).toBe("'=ЖК Альфа");
    expect(first.getCell(9).value).toBe("'-проверить");
    const second = ws.getRow(3);
    expect(second.getCell(1).value).toBe(2);
    expect(second.getCell(2).value).toBe("'@Борисов Б.");
    expect(second.getCell(6).value).toEqual(new Date(Date.UTC(1990, 4, 17)));
    expect(ws.rowCount).toBe(3);

    expect(decodeURIComponent(res.headers['Content-Disposition'])).toContain('Сотрудники_СУ-10_Уволенные_');
    expect(h.logWithClient).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'u-1', 'EXPORT_EMPLOYEES_VIEW', {
      details: expect.objectContaining({ kind: 'staff_view', count: 2, section: 'su10', status: 'fired', period: 'fired_month', sort: 'department', dir: 'desc' }),
    });
  });

  it('ошибка аудита — 500 и файл не отдаётся', async () => {
    h.query.mockResolvedValue(rows);
    h.logWithClient.mockRejectedValue(new Error('audit down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    await employeesStaffController.exportView(makeReq(), res as unknown as Response);
    err.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.sent).toBeNull();
  });

  it('пусто — 400 NO_DATA; больше предела — 400 EXPORT_TOO_LARGE; неверные параметры — 400', async () => {
    h.query.mockResolvedValueOnce([]);
    let res = makeRes();
    await employeesStaffController.exportView(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_DATA' });

    h.query.mockResolvedValueOnce({ length: 50001 } as unknown as never);
    res = makeRes();
    await employeesStaffController.exportView(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'EXPORT_TOO_LARGE' });

    for (const [query, code] of [
      [{ status: 'all' }, 'INVALID_STATUS'],
      [{ period: 'year' }, 'INVALID_PERIOD'],
      [{ sort: 'cost_item' }, 'INVALID_SORT'],
    ] as const) {
      res = makeRes();
      await employeesStaffController.exportView(makeReq(query), res as unknown as Response);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code });
    }
    expect(h.logWithClient).not.toHaveBeenCalled();
  });

  /** Связи начальников участка (индекс) — по подстроке SQL, строки выгрузки — всё остальное. */
  const mockSiteAndRows = (exportRows: unknown[]) => {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM employee_department_access')) {
        return [{ employee_id: 10, department_id: 'd-1', full_name: 'Журавлев Владимир Сергеевич', email: null }];
      }
      if (sql.includes('FROM user_employee_access')) return [];
      return exportRows;
    });
  };

  it('columns: участок между отделом и должностью, порядок экрана, повторы схлопнуты, объекты не считаются', async () => {
    mockSiteAndRows([{ ...rows[0], site_name: '=Журавлев В. С.' }]);
    const res = makeRes();
    await employeesStaffController.exportView(makeReq({ columns: 'position, site,department,site' }), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    const exportCall = h.query.mock.calls.find(([sql]) => String(sql).includes('AS site_name')) as [string, unknown[]];
    expect(exportCall[0]).toContain('s.id = employees.org_department_id');
    expect(exportCall[1]).toContainEqual(['Журавлев В. С.']);
    // Индекс грузится один раз на запрос.
    expect(h.query.mock.calls.filter(([sql]) => String(sql).includes('FROM employee_department_access'))).toHaveLength(1);
    expect(h.loadMainObjects).not.toHaveBeenCalled();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sent as unknown as ArrayBuffer);
    const ws = workbook.worksheets[0];
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(['№', 'ФИО', 'Отдел', 'Участок', 'Должность', 'Признак']);
    expect(ws.getRow(2).getCell(4).value).toBe("'=Журавлев В. С.");
    expect(h.logWithClient.mock.calls[0][4].details.columns).toEqual(['department', 'site', 'position']);
  });

  it('columns= (пусто) — только №, ФИО, Признак; без участка индекс не грузится', async () => {
    mockSiteAndRows(rows);
    const res = makeRes();
    await employeesStaffController.exportView(makeReq({ columns: '' }), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes('FROM employee_department_access'))).toBe(false);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sent as unknown as ArrayBuffer);
    expect((workbook.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual(['№', 'ФИО', 'Признак']);
    expect(h.logWithClient.mock.calls[0][4].details.columns).toEqual([]);
  });

  it('неверный columns — 400 INVALID_COLUMNS: неизвестный ключ, повтор параметра, длина', async () => {
    for (const columns of ['site,sign', 'cost_item', ['site', 'position'], 'site,'.repeat(50)]) {
      const res = makeRes();
      await employeesStaffController.exportView(makeReq({ columns }), res as unknown as Response);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_COLUMNS' });
    }
    expect(h.query).not.toHaveBeenCalled();
  });

  it('сортировка по участку — ключ из того же индекса, что и колонка', async () => {
    mockSiteAndRows([{ ...rows[0], site_name: 'Журавлев В. С.' }]);
    const res = makeRes();
    await employeesStaffController.exportView(makeReq({ sort: 'site', columns: 'site' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(h.query.mock.calls.filter(([sql]) => String(sql).includes('FROM employee_department_access'))).toHaveLength(1);
  });

  it('сортировка по объекту без снимка — 409 SORT_UNAVAILABLE', async () => {
    h.loadActiveSnapshotRun.mockResolvedValue(null);
    const res = makeRes();
    await employeesStaffController.exportView(makeReq({ sort: 'main_object' }), res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'SORT_UNAVAILABLE' });
  });
});

describe('фильтры столбцов в счётчиках и выгрузке', () => {
  const cf = JSON.stringify({ values: { sign: ['Декрет'] }, has_comment: true });

  it('month-movement учитывает фильтры столбцов, неверные — 400', async () => {
    h.queryOne.mockResolvedValue({ hired: 1, fired: 0 });
    let res = makeRes();
    await employeesStaffController.getMonthMovement(makeReq({ cf }), res as unknown as Response);
    const [sql, params] = h.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('EXISTS (SELECT 1 FROM employee_staff_comments');
    expect(params).toContainEqual(['Декрет']);

    res = makeRes();
    await employeesStaffController.getMonthMovement(makeReq({ cf: '[]' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_COLUMN_FILTERS' });
  });

  it('выгрузка учитывает фильтры и пишет их в аудит; объект без снимка — 409 FILTER_UNAVAILABLE', async () => {
    h.query.mockResolvedValue([{ id: 2, full_name: 'А', hire_date: null, birth_date: null, department_name: null, position_name: null, schedule_name: null, staff_comment: 'x', sign: 'Декрет' }]);
    let res = makeRes();
    await employeesStaffController.exportView(makeReq({ cf }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect((h.query.mock.calls[0] as [string])[0]).toContain('EXISTS (SELECT 1 FROM employee_staff_comments');
    expect(h.logWithClient.mock.calls[0][4].details.column_filters).toEqual(JSON.parse(cf));

    h.loadActiveSnapshotRun.mockResolvedValue(null);
    res = makeRes();
    await employeesStaffController.exportView(makeReq({ cf: JSON.stringify({ values: { main_object: ['ЖК'] } }) }), res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'FILTER_UNAVAILABLE' });
  });
});

describe('GET /employees/column-values', () => {
  it('варианты без фильтра своего столбца, с поиском и пометкой усечения', async () => {
    h.query.mockResolvedValue([{ value: 'Бухгалтерия', count: '3' }, { value: null, count: 1 }]);
    const res = makeRes();
    await employeesStaffController.getColumnValues(makeReq({
      column: 'department',
      q: 'бух',
      cf: JSON.stringify({ values: { department: ['Склад'], position: ['Мастер'] } }),
    }), res as unknown as Response);
    expect(res.body).toEqual({ success: true, data: { values: [{ value: 'Бухгалтерия', count: 3 }, { value: null, count: 1 }], truncated: false } });
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(params).toContainEqual(['Мастер']);
    expect(params).not.toContainEqual(['Склад']);
    expect(params).toContain('%бух%');
    expect(sql).toContain('GROUP BY v.value');
    expect(params.at(-1)).toBe(301);
  });

  it('недопустимый столбец — 400; объект без снимка — 409', async () => {
    for (const column of [undefined, 'name', 'hire_date', 'cost_item']) {
      const res = makeRes();
      await employeesStaffController.getColumnValues(makeReq({ column }), res as unknown as Response);
      expect(res.statusCode).toBe(400);
    }
    h.loadActiveSnapshotRun.mockResolvedValue(null);
    const res = makeRes();
    await employeesStaffController.getColumnValues(makeReq({ column: 'main_object' }), res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'FILTER_UNAVAILABLE' });
  });
});

describe('GET /employees/column-values — участок', () => {
  it('по отдельному начальнику: LATERAL по парам «отдел → начальник», без фильтра самого участка', async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM employee_department_access')) {
        return [
          { employee_id: 10, department_id: 'd-1', full_name: 'Журавлев Владимир Сергеевич', email: null },
          { employee_id: 11, department_id: 'd-1', full_name: 'Пудовкин Александр Александрович', email: null },
        ];
      }
      if (sql.includes('FROM user_employee_access')) return [];
      return [{ value: 'Журавлев В. С.', count: 7 }, { value: 'Пудовкин А. А.', count: 7 }, { value: null, count: 3 }];
    });
    const res = makeRes();
    await employeesStaffController.getColumnValues(makeReq({
      column: 'site',
      cf: JSON.stringify({ values: { site: ['Журавлев В. С.'] } }),
    }), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ data: { values: [{ value: 'Журавлев В. С.', count: 7 }, { value: 'Пудовкин А. А.', count: 7 }, { value: null, count: 3 }] } });
    const [sql, params] = h.query.mock.calls.find(([text]) => String(text).includes('GROUP BY v.value')) as [string, unknown[]];
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('SELECT site.label AS value FROM employees');
    expect(params).toContainEqual(['d-1', 'd-1']);
    expect(params).toContainEqual(['Журавлев В. С.', 'Пудовкин А. А.']);
    // Собственный фильтр участка в фасетах не применяется.
    expect(sql).not.toContain('employees.org_department_id = ANY(');
  });
});

describe('PUT /employees/:id/staff-comment', () => {
  const put = async (body: unknown, id = '7') => {
    const res = makeRes();
    await employeesStaffController.updateStaffComment(makeReq({}, { params: { id }, body }), res as unknown as Response);
    return res;
  };

  it('валидация: id, обязательный expected_updated_at, длина после trim', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    expect((await put({ comment: 'x', expected_updated_at: null }, 'abc')).statusCode).toBe(400);
    expect((await put({ comment: 'x' })).statusCode).toBe(400);
    expect((await put({ comment: 'x'.repeat(2001), expected_updated_at: null })).statusCode).toBe(400);
    expect((await put({ comment: `  ${'x'.repeat(2000)}  `, expected_updated_at: null })).statusCode).not.toBe(400);
  });

  it('вне скоупа — 403 без записи', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(false);
    const res = await put({ comment: 'x', expected_updated_at: null });
    expect(res.statusCode).toBe(403);
    expect(h.saveStaffComment).not.toHaveBeenCalled();
  });

  it('конфликт — 409 с актуальным значением; успех — канонические поля', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    const current = { comment: 'Чужой', updated_at: '2026-09-15T10:00:00.000001Z', updated_by_name: 'Петров' };
    h.saveStaffComment.mockResolvedValueOnce({ status: 'conflict', current });
    let res = await put({ comment: 'Мой', expected_updated_at: null });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'STAFF_COMMENT_CONFLICT', data: { current } });

    h.saveStaffComment.mockResolvedValueOnce({ status: 'ok', changed: true, current });
    res = await put({ comment: 'Чужой', expected_updated_at: null });
    expect(res.body).toEqual({ success: true, data: { changed: true, comment: 'Чужой', updated_at: current.updated_at, updated_by_name: 'Петров' } });
    expect(h.saveStaffComment).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'u-1', employeeId: 7, expectedUpdatedAt: null }));

    h.saveStaffComment.mockResolvedValueOnce({ status: 'not_found' });
    expect((await put({ comment: 'x', expected_updated_at: null })).statusCode).toBe(404);
  });
});
