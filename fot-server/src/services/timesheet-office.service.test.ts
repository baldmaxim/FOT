import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Окно «Режим табелирования» (миграция 291): порядок 400 → 403 → 409, запись «Офиса»
 * отделу и сотруднику, объекта сотруднику, отдел главнее личного, снятие с пересчётом по
 * часам, повтор без изменений, пересборка подач текущего месяца, гонки и повтор транзакции;
 * чтение — состояние, поиск, сотрудники отдела.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
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
  recompute: vi.fn(),
  labels: vi.fn(),
  skudObjects: vi.fn(),
  rebuild: vi.fn(),
  invalidateCaches: vi.fn(),
  cacheClear: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query, queryOne: h.queryOne, withTransaction: h.withTransaction }));
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
  loadTimesheetObjectLabels: h.labels,
  loadSkudObjects: h.skudObjects,
  readTimesheetObjectState: h.state,
}));
vi.mock('./timesheet-office-rule.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./timesheet-office-rule.js')>()),
  enforceOfficeForDepartments: h.enforce,
  writeOfficeAudit: h.writeAudit,
}));
vi.mock('./timesheet-object-recompute.service.js', () => ({ recomputeTimesheetObjectsNow: h.recompute }));
vi.mock('./timesheet-version-objects-rebuild.service.js', () => ({ rebuildVersionObjectsForMonth: h.rebuild }));

const { TimesheetOfficeError, updateTimesheetOffice } = await import('./timesheet-office.service.js');
const {
  getTimesheetOfficeDepartmentMembers,
  getTimesheetOfficeEmployee,
  getTimesheetOfficeState,
  searchTimesheetOfficeEmployees,
} = await import('./timesheet-office-read.service.js');

const NOW = new Date('2026-09-29T12:00:00+03:00');
const DEPT = '11111111-1111-4111-8111-111111111111';
const DEPT2 = '33333333-3333-4333-8333-333333333333';
const CONTRACTOR_DEPT = '22222222-2222-4222-8222-222222222222';
const req = { user: { id: 'user-1' }, ip: '1.1.1.1', headers: {}, socket: {} } as never;

const O_DOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const O_METRO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const O_OLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const O_OFFICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SKUD_OBJECTS = new Map([
  [O_DOM, { id: O_DOM, name: 'ЖК Дом 56', alt_name: 'Фридриха Энгельса ул., 56', is_active: true }],
  [O_METRO, { id: O_METRO, name: 'ЖК Метрополия', alt_name: 'Волгоградский пр-т, 32', is_active: true }],
  [O_OLD, { id: O_OLD, name: 'Старый объект', alt_name: 'Адрес', is_active: false }],
  [O_OFFICE, { id: O_OFFICE, name: 'Офис Полковая', alt_name: 'Текущая деятельность', is_active: true }],
]);

const empty = { departments: { add: [], remove: [] }, employees: { add: [], remove: [] } };
const input = (over: Partial<{
  dAdd: string[]; dRemove: string[]; eAdd: number[]; eRemove: number[];
  eObjects: Array<{ id: number; object_id: string }>;
}>) => ({
  departments: { add: over.dAdd ?? [], remove: over.dRemove ?? [] },
  employees: { add: over.eAdd ?? [], remove: over.eRemove ?? [], objects: over.eObjects ?? [] },
});

type EmployeeRow = Record<string, unknown>;
const employee = (id: number, over: EmployeeRow = {}): EmployeeRow => ({
  id, full_name: `Сотрудник ${id}`, is_archived: false, employment_status: 'active',
  org_department_id: DEPT, mode: 'object', object_id: O_DOM, set_by: 'auto', personal_office: false,
  personal_pin: false, ...over,
});
/** Личный «Офис» из окна. */
const officePin = { mode: 'current_activity', object_id: null, set_by: null, personal_office: true, personal_pin: true };
/** Объект из окна. */
const objectPin = (objectId: string) => ({ mode: 'object', object_id: objectId, set_by: null, personal_pin: true });

/** Строки для проверок до транзакции и под FOR UPDATE; lockedRows — если состояние «уплыло». */
function setup(options: {
  departments?: Array<{ id: string; is_active: boolean; kind: string | null }>;
  rules?: string[];
  /** Отделы с «Офисом», которые видит транзакция под локом (по умолчанию — rules). */
  lockedRules?: string[];
  employees?: EmployeeRow[];
  lockedEmployees?: EmployeeRow[];
  insertedDepartments?: string[];
  deletedDepartments?: string[];
  updatedAdd?: number[];
  updatedObjects?: number[];
  updatedRemove?: number[];
  departmentMembers?: number[];
} = {}) {
  const rulesAmong = (rules: string[] | undefined, params: unknown[] | undefined) =>
    (rules ?? []).filter(id => (params?.[0] as string[]).includes(id)).map(id => ({ id }));
  h.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM org_departments WHERE id = ANY')) return options.departments ?? [];
    if (sql.includes('FROM timesheet_office_departments WHERE org_department_id = ANY')) {
      return rulesAmong(options.rules, params);
    }
    if (sql.includes('FROM employees e') && sql.includes('WHERE e.id = ANY')) return options.employees ?? [];
    return [];
  });
  h.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM timesheet_office_departments WHERE org_department_id = ANY')) {
      return { rows: rulesAmong(options.lockedRules ?? options.rules, params) };
    }
    if (sql.includes('SELECT e.id FROM employees e')) {
      return { rows: (options.departmentMembers ?? []).map(id => ({ id })) };
    }
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
    if (sql.includes("SET timesheet_export_mode = 'object'")) {
      return { rows: (options.updatedObjects ?? []).map(id => ({ id })) };
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
  h.recompute.mockResolvedValue([]);
  h.labels.mockResolvedValue(new Map());
  h.skudObjects.mockResolvedValue(SKUD_OBJECTS);
  h.rebuild.mockResolvedValue({ approvals: 0, created: 0, failures: 0 });
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

  it('назначение главнее отдела: сотруднику отдела с «Офисом» — и «Офис», и объект; и вместе с «Офисом» отделу', async () => {
    setup({ rules: [DEPT], employees: [employee(11), employee(12)], updatedAdd: [11], updatedObjects: [12] });
    await expect(updateTimesheetOffice(req, input({ eAdd: [11], eObjects: [{ id: 12, object_id: O_METRO }] }), NOW))
      .resolves.toMatchObject({ employees_added: 1, objects_assigned: 1 });

    setup({
      departments: [{ id: DEPT2, is_active: true, kind: 'department' }],
      employees: [employee(13, { org_department_id: DEPT2 })], insertedDepartments: [DEPT2], updatedObjects: [13],
    });
    await expect(updateTimesheetOffice(req, input({ dAdd: [DEPT2], eObjects: [{ id: 13, object_id: O_DOM }] }), NOW))
      .resolves.toMatchObject({ departments_added: 1, objects_assigned: 1 });
  });

  it('«Офис» с отдела снимают этим же запросом — личный «Офис» его сотруднику можно', async () => {
    setup({ rules: [DEPT], employees: [employee(13)], deletedDepartments: [DEPT], updatedAdd: [13] });
    await expect(updateTimesheetOffice(req, input({ dRemove: [DEPT], eAdd: [13] }), NOW)).resolves.toMatchObject({
      employees_added: 1, departments_removed: 1,
    });
  });

  it('вне доступа — 403, транзакции нет', async () => {
    setup({ departments: [{ id: DEPT, is_active: true, kind: 'department' }], employees: [employee(5, { org_department_id: DEPT2 })] });
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
      employees_added: 0, objects_assigned: 0, employees_removed: 0, members_applied: 1, recomputed: 0,
    });
    // «Офис» отдела — подачи ждут фиксации месяца, как раньше.
    expect(h.rebuild).not.toHaveBeenCalled();
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
        employee(9, officePin),
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

  it('снять личный «Офис» — источник auto и сразу пересчёт по часам в той же транзакции', async () => {
    setup({
      employees: [employee(10, officePin)],
      updatedRemove: [10],
    });
    h.recompute.mockResolvedValue([10]);
    const result = await updateTimesheetOffice(req, input({ eRemove: [10] }), NOW);
    expect(result).toMatchObject({ changed: true, employees_removed: 1, recomputed: 1 });
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).includes("SET timesheet_export_set_by = 'auto'"));
    expect(update?.[1]).toEqual([[10]]);
    expect(h.recompute).toHaveBeenCalledWith(expect.objectContaining({ query: h.clientQuery }), [10], {
      contractorIds: [CONTRACTOR_DEPT], now: NOW, userId: 'user-1', reason: 'office_removed',
    });
    expect(h.rebuild).toHaveBeenCalledWith('2026-09-01', { employeeIds: [10], onlyListedEmployees: true });
  });

  it('снять «Офис» с отдела — строка правила удаляется, прямые работающие сотрудники пересчитываются', async () => {
    setup({ rules: [DEPT], deletedDepartments: [DEPT], departmentMembers: [40, 41] });
    const result = await updateTimesheetOffice(req, input({ dRemove: [DEPT] }), NOW);
    expect(result).toMatchObject({ changed: true, departments_removed: 1, recomputed: 0 });
    expect(h.canWriteDepartment).toHaveBeenCalledWith(req, DEPT);
    const members = h.clientQuery.mock.calls.find(([sql]) => String(sql).includes('SELECT e.id FROM employees e'));
    expect(String(members?.[0])).toContain("e.employment_status = 'active'");
    expect(members?.[1]).toEqual([[DEPT]]);
    expect(h.recompute).toHaveBeenCalledWith(expect.anything(), [40, 41], expect.objectContaining({ reason: 'office_removed' }));
  });

  it('ошибка пересчёта откатывает и снятие — наружу, без сброса кэшей', async () => {
    setup({
      employees: [employee(15, officePin)],
      updatedRemove: [15],
    });
    h.recompute.mockRejectedValue(new Error('hours down'));
    await expect(updateTimesheetOffice(req, input({ eRemove: [15] }), NOW)).rejects.toThrow('hours down');
    expect(h.invalidateCaches).not.toHaveBeenCalled();
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

describe('updateTimesheetOffice — объект сотруднику', () => {
  const objectUpdate = () => h.clientQuery.mock.calls.find(([sql]) => String(sql).includes("SET timesheet_export_mode = 'object'"));

  it('объект поверх авто: источник NULL, автор, дата, аудит; сразу пересборка подач текущего месяца', async () => {
    setup({ employees: [employee(70, { object_id: O_METRO })], updatedObjects: [70] });
    const result = await updateTimesheetOffice(req, input({ eObjects: [{ id: 70, object_id: O_DOM }] }), NOW);
    expect(result).toMatchObject({ changed: true, objects_assigned: 1, employees_added: 0 });
    const update = objectUpdate();
    expect(update?.[1]).toEqual([[70], [O_DOM], 'user-1']);
    const sql = String(update?.[0]);
    expect(sql).toContain('timesheet_export_set_by = NULL');
    expect(sql).toContain('timesheet_export_set_at = now()');
    expect(sql).toContain('timesheet_export_set_by_user_id = $3::uuid');
    // Точный повтор отсекается и в самом UPDATE.
    expect(sql).toContain('e.timesheet_export_object_id = c.object_id');
    const [, entries] = h.writeAudit.mock.calls[0];
    expect(entries[0]).toMatchObject({
      entityId: '70',
      details: { via: 'personal', new_mode: 'object', new_object_id: O_DOM, new_set_by: null, old_object_id: O_METRO },
    });
    expect(h.rebuild).toHaveBeenCalledWith('2026-09-01', { employeeIds: [70], onlyListedEmployees: true });
    expect(h.invalidateCaches).toHaveBeenCalled();
  });

  it('тот же объект от авто — один раз становится назначением', async () => {
    setup({ employees: [employee(71, { object_id: O_DOM, set_by: 'auto' })], updatedObjects: [71] });
    const result = await updateTimesheetOffice(req, input({ eObjects: [{ id: 71, object_id: O_DOM }] }), NOW);
    expect(result).toMatchObject({ changed: true, objects_assigned: 1 });
    expect(objectUpdate()?.[1]).toEqual([[71], [O_DOM], 'user-1']);
  });

  it('точный повтор — без UPDATE, аудита, сброса кэшей и пересборки', async () => {
    setup({ employees: [employee(72, objectPin(O_DOM))] });
    const result = await updateTimesheetOffice(req, input({ eObjects: [{ id: 72, object_id: O_DOM.toUpperCase() }] }), NOW);
    expect(result).toMatchObject({ changed: false, objects_assigned: 0 });
    expect(objectUpdate()).toBeUndefined();
    expect(h.writeAudit.mock.calls[0]?.[1]).toEqual([]);
    expect(h.invalidateCaches).not.toHaveBeenCalled();
    expect(h.rebuild).not.toHaveBeenCalled();
  });

  it('«Офис» → объект и объект → другой объект', async () => {
    setup({ employees: [employee(73, officePin), employee(74, objectPin(O_METRO))], updatedObjects: [73, 74] });
    const result = await updateTimesheetOffice(req, input({
      eObjects: [{ id: 74, object_id: O_DOM }, { id: 73, object_id: O_DOM }],
    }), NOW);
    expect(result).toMatchObject({ objects_assigned: 2 });
    // id по возрастанию — порядок запроса на запись не влияет.
    expect(objectUpdate()?.[1]).toEqual([[73, 74], [O_DOM, O_DOM], 'user-1']);
  });

  it('одинаковые пары схлопываются; разные объекты одному сотруднику — 400', async () => {
    setup({ employees: [employee(75)], updatedObjects: [75] });
    await updateTimesheetOffice(req, input({
      eObjects: [{ id: 75, object_id: O_METRO }, { id: 75, object_id: O_METRO }],
    }), NOW);
    expect(objectUpdate()?.[1]).toEqual([[75], [O_METRO], 'user-1']);

    await expect(updateTimesheetOffice(req, input({
      eObjects: [{ id: 75, object_id: O_METRO }, { id: 75, object_id: O_DOM }],
    }), NOW)).rejects.toMatchObject({ status: 400, code: 'TIMESHEET_OFFICE_INVALID', details: [75] });
  });

  it('один id в объектах и в «Офисе» или снятии — 400 до записи', async () => {
    setup({ employees: [employee(76)] });
    for (const request of [
      input({ eAdd: [76], eObjects: [{ id: 76, object_id: O_DOM }] }),
      input({ eRemove: [76], eObjects: [{ id: 76, object_id: O_DOM }] }),
    ]) {
      await expect(updateTimesheetOffice(req, request, NOW)).rejects.toMatchObject({ status: 400, details: ['76'] });
    }
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('объект не найден, офисный или неактивный — 400; неактивный при точном повторе — no-op', async () => {
    setup({ employees: [employee(77), employee(78), employee(79), employee(80, objectPin(O_OLD))] });
    await expect(updateTimesheetOffice(req, input({
      eObjects: [
        { id: 77, object_id: '99999999-9999-4999-8999-999999999999' },
        { id: 78, object_id: O_OFFICE },
        { id: 79, object_id: O_OLD },
      ],
    }), NOW)).rejects.toMatchObject({ status: 400, details: [77, 78, 79] });
    expect(h.withTransaction).not.toHaveBeenCalled();

    const repeat = await updateTimesheetOffice(req, input({ eObjects: [{ id: 80, object_id: O_OLD }] }), NOW);
    expect(repeat.changed).toBe(false);
    expect(objectUpdate()).toBeUndefined();
  });

  it('снять назначение у сотрудника отдела с «Офисом» — правило отдела сразу, в той же транзакции', async () => {
    setup({ rules: [DEPT], employees: [employee(81, objectPin(O_DOM))], updatedRemove: [81] });
    h.enforce.mockResolvedValue([
      { employeeId: 81, fullName: 'Сотрудник 81', departmentId: DEPT, fromMode: 'object', fromObjectId: O_DOM, fromSetBy: 'auto' },
    ]);
    const result = await updateTimesheetOffice(req, input({ eRemove: [81] }), NOW);
    expect(result).toMatchObject({ changed: true, employees_removed: 1, members_applied: 1 });
    expect(h.enforce).toHaveBeenCalledWith(expect.objectContaining({ query: h.clientQuery }), [DEPT], [CONTRACTOR_DEPT]);
    const [, entries] = h.writeAudit.mock.calls[0];
    expect(entries.map((entry: { details: { via: string } }) => entry.details.via)).toEqual(['personal', 'department']);
    // Снятие пишется раньше правила: иначе правило не увидело бы сотрудника (назначение главнее).
    const removal = h.clientQuery.mock.calls.findIndex(([sql]) => String(sql).includes("SET timesheet_export_set_by = 'auto'"));
    expect(h.clientQuery.mock.invocationCallOrder[removal]).toBeLessThan(h.enforce.mock.invocationCallOrder[0]);
  });

  it('снять назначенный объект — источник auto, пересчёт по часам и пересборка подач', async () => {
    setup({ employees: [employee(82, objectPin(O_DOM))], updatedRemove: [82] });
    const result = await updateTimesheetOffice(req, input({ eRemove: [82] }), NOW);
    expect(result).toMatchObject({ changed: true, employees_removed: 1 });
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).includes("SET timesheet_export_set_by = 'auto'"));
    expect(update?.[1]).toEqual([[82]]);
    expect(h.recompute).toHaveBeenCalledWith(expect.anything(), [82], expect.objectContaining({ reason: 'office_removed' }));
    const [, entries] = h.writeAudit.mock.calls[0];
    expect(entries[0]).toMatchObject({ details: { action: 'remove', new_set_by: 'auto', new_object_id: O_DOM } });
    expect(h.rebuild).toHaveBeenCalledWith('2026-09-01', { employeeIds: [82], onlyListedEmployees: true });
  });

  it('сбой пересборки подач не откатывает запись окна', async () => {
    setup({ employees: [employee(83)], updatedObjects: [83] });
    h.rebuild.mockRejectedValue(new Error('rebuild down'));
    await expect(updateTimesheetOffice(req, input({ eObjects: [{ id: 83, object_id: O_DOM }] }), NOW)).resolves.toMatchObject({
      changed: true, objects_assigned: 1,
    });
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
      employees: [{ id: 20, full_name: 'Шупта', department: 'Бухгалтерия', label: 'Офис' }],
      objects: [{ id: O_DOM, name: 'ЖК Дом 56' }, { id: O_METRO, name: 'ЖК Метрополия' }],
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

describe('сотрудники отдела', () => {
  it('отдел не найден, неактивен, объектный или подрядный — 400 до прав', async () => {
    for (const row of [null, { is_active: false, kind: 'department', office: false }, { is_active: true, kind: 'object', office: false }]) {
      h.queryOne.mockResolvedValueOnce(row);
      await expect(getTimesheetOfficeDepartmentMembers(req, DEPT)).rejects.toMatchObject({ status: 400, code: 'TIMESHEET_OFFICE_INVALID' });
    }
    h.queryOne.mockResolvedValueOnce({ is_active: true, kind: 'department', office: false });
    await expect(getTimesheetOfficeDepartmentMembers(req, CONTRACTOR_DEPT)).rejects.toMatchObject({ status: 400 });
    expect(h.canWriteDepartment).not.toHaveBeenCalled();
  });

  it('вне скоупа записи — 403', async () => {
    h.queryOne.mockResolvedValue({ is_active: true, kind: 'department', office: false });
    h.canWriteDepartment.mockResolvedValue(false);
    await expect(getTimesheetOfficeDepartmentMembers(req, DEPT)).rejects.toMatchObject({ status: 403, code: 'TIMESHEET_OFFICE_FORBIDDEN' });
    expect(h.query).not.toHaveBeenCalled();
  });

  it('прямые работающие не архивные, по ФИО и id; объект на сейчас и личный «Офис»', async () => {
    h.queryOne.mockResolvedValue({ is_active: true, kind: 'department', office: true });
    h.query.mockResolvedValue([
      { id: '50', full_name: 'Алексеев', personal_office: false, personal_assignment: O_METRO },
      { id: 51, full_name: 'Борисов', personal_office: true, personal_assignment: 'office' },
      { id: 52, full_name: 'Васильев', personal_office: false, personal_assignment: null },
    ]);
    h.labels.mockResolvedValue(new Map([[50, 'ЖК Метрополия'], [51, 'Офис']]));

    const result = await getTimesheetOfficeDepartmentMembers(req, DEPT);

    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE e.org_department_id = $1::uuid');
    expect(sql).not.toContain('get_descendant_department_ids');
    expect(sql).toContain('e.is_archived = false');
    expect(sql).toContain("e.employment_status = 'active'");
    expect(sql).toContain('ORDER BY e.full_name, e.id');
    expect(params).toEqual([DEPT]);
    expect(h.labels).toHaveBeenCalledWith([50, 51, 52]);
    expect(result).toEqual({
      office: true,
      employees: [
        { id: 50, full_name: 'Алексеев', label: 'ЖК Метрополия', personal_office: false, personal_assignment: O_METRO },
        { id: 51, full_name: 'Борисов', label: 'Офис', personal_office: true, personal_assignment: 'office' },
        { id: 52, full_name: 'Васильев', label: null, personal_office: false, personal_assignment: null },
      ],
    });
  });
});

describe('сотрудник для вкладки «Сотрудник»', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: '60', full_name: 'Семенов Иван', is_archived: false, employment_status: 'active',
    org_department_id: DEPT, department: 'Бухгалтерия', personal_office: false, personal_assignment: null,
    department_office: false, ...over,
  });

  it('не найден, в архиве, не работает, без отдела или подрядчик — 400 до прав', async () => {
    for (const value of [null, row({ is_archived: true }), row({ employment_status: 'fired' }), row({ org_department_id: null }), row({ org_department_id: CONTRACTOR_DEPT })]) {
      h.queryOne.mockResolvedValueOnce(value);
      await expect(getTimesheetOfficeEmployee(req, 60)).rejects.toMatchObject({ status: 400, code: 'TIMESHEET_OFFICE_INVALID' });
    }
    expect(h.canWriteEmployee).not.toHaveBeenCalled();
  });

  it('вне скоупа записи — 403', async () => {
    h.queryOne.mockResolvedValue(row());
    h.canWriteEmployee.mockResolvedValue(false);
    await expect(getTimesheetOfficeEmployee(req, 60)).rejects.toMatchObject({ status: 403, code: 'TIMESHEET_OFFICE_FORBIDDEN' });
  });

  it('строка: объект на сейчас, личный «Офис», «Офис» отдела', async () => {
    h.queryOne.mockResolvedValue(row({ personal_office: false, department_office: true }));
    h.labels.mockResolvedValue(new Map([[60, 'Офис']]));
    await expect(getTimesheetOfficeEmployee(req, 60)).resolves.toEqual({
      id: 60, full_name: 'Семенов Иван', department: 'Бухгалтерия', label: 'Офис', personal_office: false,
      personal_assignment: null, department_office: true,
    });
    const [sql, params] = h.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM timesheet_office_departments tod');
    expect(params).toEqual([60]);
    expect(h.canWriteEmployee).toHaveBeenCalledWith(req, 60);
  });
});

describe('TimesheetOfficeError', () => {
  it('несёт статус, код и подробности', () => {
    const error = new TimesheetOfficeError(409, 'TIMESHEET_OFFICE_CHANGED', 'x', [1]);
    expect(error).toMatchObject({ status: 409, code: 'TIMESHEET_OFFICE_CHANGED', details: [1] });
  });
});
