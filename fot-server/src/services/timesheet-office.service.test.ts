import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Окно «Режим табелирования» (миграция 291): порядок 400 → 403 → 409, запись «Офиса»
 * отделу и сотруднику, снятие, повтор без изменений, гонки и повтор транзакции.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  withTransaction: vi.fn(),
  canWriteDepartment: vi.fn(),
  canWriteEmployee: vi.fn(),
  accessible: vi.fn(),
  writable: vi.fn(),
  contractors: vi.fn(),
  state: vi.fn(),
  enforce: vi.fn(),
  writeAudit: vi.fn(),
  invalidateCaches: vi.fn(),
  cacheClear: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query, withTransaction: h.withTransaction }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: h.invalidateCaches }));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { clear: h.cacheClear } }));
vi.mock('./data-scope.service.js', () => ({
  canWriteDepartmentInScope: h.canWriteDepartment,
  canWriteEmployeeInScope: h.canWriteEmployee,
  resolveAccessibleDepartmentIds: h.accessible,
  resolveWritableScopedDepartmentIds: h.writable,
}));
vi.mock('./employee-timesheet-object.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./employee-timesheet-object.service.js')>()),
  loadContractorDepartmentIds: h.contractors,
  readTimesheetObjectState: h.state,
}));
vi.mock('./timesheet-office-rule.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./timesheet-office-rule.js')>()),
  enforceOfficeForDepartments: h.enforce,
  writeOfficeAudit: h.writeAudit,
}));

const {
  TimesheetOfficeError,
  getTimesheetOfficeState,
  searchTimesheetOfficeEmployees,
  updateTimesheetOffice,
} = await import('./timesheet-office.service.js');

const NOW = new Date('2026-09-29T12:00:00+03:00');
const DEPT = '11111111-1111-4111-8111-111111111111';
const DEPT2 = '33333333-3333-4333-8333-333333333333';
const CONTRACTOR_DEPT = '22222222-2222-4222-8222-222222222222';
const req = { user: { id: 'user-1' }, ip: '1.1.1.1', headers: {}, socket: {} } as never;

const empty = { departments: { add: [], remove: [] }, employees: { add: [], remove: [] } };
const input = (over: Partial<{ dAdd: string[]; dRemove: string[]; eAdd: number[]; eRemove: number[] }>) => ({
  departments: { add: over.dAdd ?? [], remove: over.dRemove ?? [] },
  employees: { add: over.eAdd ?? [], remove: over.eRemove ?? [] },
});

type EmployeeRow = Record<string, unknown>;
const employee = (id: number, over: EmployeeRow = {}): EmployeeRow => ({
  id, full_name: `Сотрудник ${id}`, is_archived: false, employment_status: 'active',
  org_department_id: DEPT, mode: 'object', object_id: 'o-dom', set_by: 'auto', personal_office: false, ...over,
});

/** Строки для проверок до транзакции и под FOR UPDATE; lockedRows — если состояние «уплыло». */
function setup(options: {
  departments?: Array<{ id: string; is_active: boolean; kind: string | null }>;
  rules?: string[];
  employees?: EmployeeRow[];
  lockedEmployees?: EmployeeRow[];
  insertedDepartments?: string[];
  deletedDepartments?: string[];
  updatedAdd?: number[];
  updatedRemove?: number[];
} = {}) {
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM org_departments WHERE id = ANY')) return options.departments ?? [];
    if (sql.includes('FROM timesheet_office_departments WHERE org_department_id = ANY')) {
      return (options.rules ?? []).map(id => ({ id }));
    }
    if (sql.includes('FROM employees e') && sql.includes('WHERE e.id = ANY')) return options.employees ?? [];
    return [];
  });
  h.clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FOR UPDATE')) return { rows: options.lockedEmployees ?? options.employees ?? [] };
    if (sql.includes('INSERT INTO timesheet_office_departments')) {
      return { rows: (options.insertedDepartments ?? []).map(id => ({ id, name: 'Бухгалтерия' })) };
    }
    if (sql.includes('DELETE FROM timesheet_office_departments')) {
      return { rows: (options.deletedDepartments ?? []).map(id => ({ id, name: 'Бухгалтерия' })) };
    }
    if (sql.includes("SET timesheet_export_set_by = 'auto'")) {
      return { rows: (options.updatedRemove ?? []).map(id => ({ id })) };
    }
    if (sql.includes('timesheet_export_set_by = NULL')) {
      return { rows: (options.updatedAdd ?? []).map(id => ({ id })) };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: h.clientQuery }));
  h.canWriteDepartment.mockResolvedValue(true);
  h.canWriteEmployee.mockResolvedValue(true);
  h.accessible.mockResolvedValue('all');
  h.writable.mockImplementation(async (_req: unknown, ids: string[]) => ids);
  h.contractors.mockResolvedValue([CONTRACTOR_DEPT]);
  h.state.mockResolvedValue({ enabled: true, frozen_month: '2026-08-01' });
  h.enforce.mockResolvedValue([]);
  h.writeAudit.mockResolvedValue(undefined);
  setup();
});

describe('updateTimesheetOffice — проверки до записи', () => {
  it('пустой запрос — ничего не делает', async () => {
    await expect(updateTimesheetOffice(req, empty, NOW)).resolves.toMatchObject({ changed: false });
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('один id и в добавлении, и в снятии — 400', async () => {
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT], dRemove: [DEPT] }), NOW)).rejects.toMatchObject({
      status: 400, code: 'TIMESHEET_OFFICE_INVALID',
    });
  });

  it('отдел не найден, неактивен или подрядный — 400 до прав', async () => {
    setup({ departments: [
      { id: DEPT, is_active: false, kind: 'department' },
      { id: CONTRACTOR_DEPT, is_active: true, kind: 'department' },
    ] });
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT, CONTRACTOR_DEPT, DEPT2] }), NOW)).rejects.toMatchObject({
      status: 400, details: [DEPT, CONTRACTOR_DEPT, DEPT2],
    });
    expect(h.canWriteDepartment).not.toHaveBeenCalled();
  });

  it('сотрудник уволен, в архиве или подрядчик — 400', async () => {
    setup({ employees: [
      employee(1, { employment_status: 'dismissed' }),
      employee(2, { is_archived: true }),
      employee(3, { org_department_id: CONTRACTOR_DEPT }),
    ] });
    await expect(updateTimesheetOffice(req, input({ eAdd: [1, 2, 3, 4] }), NOW)).rejects.toMatchObject({
      status: 400, code: 'TIMESHEET_OFFICE_INVALID', details: [1, 2, 3, 4],
    });
  });

  it('вне доступа — 403, транзакции нет', async () => {
    setup({ departments: [{ id: DEPT, is_active: true, kind: 'department' }], employees: [employee(5)] });
    h.canWriteDepartment.mockResolvedValue(false);
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT], eAdd: [5] }), NOW)).rejects.toMatchObject({
      status: 403, code: 'TIMESHEET_OFFICE_FORBIDDEN', details: { departments: [DEPT], employees: [] },
    });
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('снятие несуществующего правила и не личного «Офиса» — без проверки прав и без изменений', async () => {
    setup({ rules: [], employees: [employee(6, { mode: 'current_activity', set_by: 'auto' })] });
    const result = await updateTimesheetOffice(req, input({ dRemove: [DEPT], eRemove: [6] }), NOW);
    expect(result.changed).toBe(false);
    expect(h.canWriteDepartment).not.toHaveBeenCalled();
    expect(h.canWriteEmployee).not.toHaveBeenCalled();
    expect(h.invalidateCaches).not.toHaveBeenCalled();
  });
});

describe('updateTimesheetOffice — транзакция', () => {
  it('прошлый месяц не зафиксирован или нет состояния — 409, ничего не записано (fail-closed)', async () => {
    setup({ departments: [{ id: DEPT, is_active: true, kind: 'department' }] });
    h.state.mockResolvedValue({ enabled: true, frozen_month: '2026-07-01' });
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT] }), NOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OFFICE_MONTH_NOT_FROZEN',
    });
    h.state.mockResolvedValue(null);
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT] }), NOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OFFICE_MONTH_NOT_FROZEN',
    });
    expect(h.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
    // Лок режимов — первым запросом транзакции.
    expect(h.clientQuery.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
  });

  it('сотрудника перевели между проверкой и записью — 409, без UPDATE', async () => {
    setup({ employees: [employee(7)], lockedEmployees: [employee(7, { org_department_id: DEPT2 })] });
    await expect(updateTimesheetOffice(req, input({ eAdd: [7] }), NOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OFFICE_CHANGED', details: [7],
    });
    expect(h.clientQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
  });

  it('«Офис» отделу: правило, «Офис» сотрудникам отдела, аудит, сброс кэшей', async () => {
    setup({ departments: [{ id: DEPT, is_active: true, kind: 'department' }], insertedDepartments: [DEPT] });
    h.enforce.mockResolvedValue([
      { employeeId: 20, fullName: 'Шупта', departmentId: DEPT, fromMode: 'object', fromObjectId: 'o-metro', fromSetBy: 'employee' },
    ]);
    const result = await updateTimesheetOffice(req, input({ dAdd: [DEPT] }), NOW);
    expect(result).toEqual({
      changed: true, departments_added: 1, departments_removed: 0,
      employees_added: 0, employees_removed: 0, members_applied: 1,
    });
    const insert = h.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO timesheet_office_departments'));
    expect(insert?.[1]).toEqual([[DEPT], 'user-1']);
    expect(h.enforce).toHaveBeenCalledWith(expect.anything(), [DEPT], [CONTRACTOR_DEPT]);
    const [, entries, actor] = h.writeAudit.mock.calls[0];
    expect(actor).toEqual({ req, userId: 'user-1' });
    expect(entries.map((entry: { entityType: string; entityId: string }) => `${entry.entityType}:${entry.entityId}`))
      .toEqual([`org_department:${DEPT}`, 'employee:20']);
    expect(h.cacheClear).toHaveBeenCalled();
    expect(h.invalidateCaches).toHaveBeenCalled();
  });

  it('отдел уже с «Офисом» — правило применяется новым сотрудникам, как сделала бы ночь', async () => {
    setup({ departments: [{ id: DEPT, is_active: true, kind: 'department' }], insertedDepartments: [] });
    const repeat = await updateTimesheetOffice(req, input({ dAdd: [DEPT] }), NOW);
    expect(repeat.changed).toBe(false);
    expect(h.enforce).toHaveBeenCalledWith(expect.anything(), [DEPT], [CONTRACTOR_DEPT]);
    expect(h.invalidateCaches).not.toHaveBeenCalled();
  });

  it('личный «Офис» — поверх «Офиса» от авто: источник NULL, автор, дата; личный уже — пропуск', async () => {
    setup({
      employees: [
        employee(8, { mode: 'current_activity', object_id: null, set_by: 'auto' }),
        employee(9, { mode: 'current_activity', object_id: null, set_by: null, personal_office: true }),
      ],
      updatedAdd: [8],
    });
    const result = await updateTimesheetOffice(req, input({ eAdd: [8, 9] }), NOW);
    expect(result).toMatchObject({ changed: true, employees_added: 1 });
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).includes('timesheet_export_set_by = NULL'));
    expect(update?.[1]).toEqual([[8], 'user-1']);
    expect(String(update?.[0])).toContain('timesheet_export_set_at = now()');
    expect(String(update?.[0])).toContain('timesheet_export_set_by_user_id = $2::uuid');
  });

  it('снять личный «Офис» — источник auto (объект пересчитает ночь)', async () => {
    setup({
      employees: [employee(10, { mode: 'current_activity', object_id: null, set_by: null, personal_office: true })],
      updatedRemove: [10],
    });
    const result = await updateTimesheetOffice(req, input({ eRemove: [10] }), NOW);
    expect(result).toMatchObject({ changed: true, employees_removed: 1 });
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).includes("SET timesheet_export_set_by = 'auto'"));
    expect(update?.[1]).toEqual([[10]]);
  });

  it('снять «Офис» с отдела — строка правила удаляется', async () => {
    setup({ rules: [DEPT], deletedDepartments: [DEPT] });
    const result = await updateTimesheetOffice(req, input({ dRemove: [DEPT] }), NOW);
    expect(result).toMatchObject({ changed: true, departments_removed: 1 });
    expect(h.canWriteDepartment).toHaveBeenCalledWith(req, DEPT);
  });

  it('взаимная блокировка — повтор транзакции; три подряд — 409', async () => {
    setup({ departments: [{ id: DEPT, is_active: true, kind: 'department' }], insertedDepartments: [DEPT] });
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    h.withTransaction
      .mockRejectedValueOnce(deadlock)
      .mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: h.clientQuery }));
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT] }), NOW)).resolves.toMatchObject({ changed: true });
    expect(h.withTransaction).toHaveBeenCalledTimes(2);

    h.withTransaction.mockReset();
    h.withTransaction.mockRejectedValue(deadlock);
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT] }), NOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OFFICE_BUSY',
    });
    expect(h.withTransaction).toHaveBeenCalledTimes(3);
  });

  it('ошибка аудита откатывает всё — наружу, без сброса кэшей', async () => {
    setup({ departments: [{ id: DEPT, is_active: true, kind: 'department' }], insertedDepartments: [DEPT] });
    h.writeAudit.mockRejectedValue(new Error('audit down'));
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT] }), NOW)).rejects.toThrow('audit down');
    expect(h.invalidateCaches).not.toHaveBeenCalled();
  });
});

describe('чтение', () => {
  it('состояние: отделы — по скоупу записи (с id), списки — по скоупу чтения', async () => {
    h.accessible.mockResolvedValue([DEPT]);
    h.writable.mockResolvedValue([DEPT]);
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM org_departments') && sql.includes('is_active = true')) return [{ id: DEPT }, { id: DEPT2 }];
      if (sql.includes('FROM timesheet_office_departments tod')) {
        return [{ id: DEPT, name: 'Бухгалтерия', employees_count: 16 }, { id: DEPT2, name: 'Чужой', employees_count: 3 }];
      }
      if (sql.includes('FROM employees e')) {
        return [
          { id: 20, full_name: 'Шупта', department_id: DEPT, department: 'Бухгалтерия' },
          { id: 21, full_name: 'Чужой', department_id: DEPT2, department: 'Чужой' },
        ];
      }
      return [];
    });
    const state = await getTimesheetOfficeState(req);
    expect(h.writable).toHaveBeenCalledWith(req, [DEPT, DEPT2]);
    expect(state).toEqual({
      allowed_department_ids: [DEPT],
      departments: [{ id: DEPT, name: 'Бухгалтерия', employees_count: 16 }],
      employees: [{ id: 20, full_name: 'Шупта', department: 'Бухгалтерия' }],
    });
  });

  it('поиск: ё → е, без подрядчиков, в скоупе записи; короче 2 символов — без запроса', async () => {
    expect(await searchTimesheetOfficeEmployees(req, 'С')).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();

    h.accessible.mockResolvedValue([DEPT]);
    h.writable.mockResolvedValue([DEPT]);
    h.query.mockResolvedValue([{ id: 30, full_name: 'Семенов', department: 'Бухгалтерия' }]);
    const rows = await searchTimesheetOfficeEmployees(req, 'Семёнов');
    expect(rows).toEqual([{ id: 30, full_name: 'Семенов', department: 'Бухгалтерия' }]);
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("replace(lower(e.full_name), 'ё', 'е') LIKE $2");
    expect(sql).toContain('ORDER BY e.full_name, e.id');
    expect(params).toEqual([[CONTRACTOR_DEPT], '%семенов%', [DEPT]]);
  });
});

describe('TimesheetOfficeError', () => {
  it('несёт статус, код и подробности', () => {
    const error = new TimesheetOfficeError(409, 'TIMESHEET_OFFICE_CHANGED', 'x', [1]);
    expect(error).toMatchObject({ status: 409, code: 'TIMESHEET_OFFICE_CHANGED', details: [1] });
  });
});
