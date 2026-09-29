import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Выбор объекта табелирования вручную (миграция 288): сотрудник в ЛК и тот, кто ведёт
 * табель. Порог 24 ч, окно последних 3 дней, исключение для новичка, повтор без записи.
 */

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  clientQuery: vi.fn(),
  audit: vi.fn(),
  invalidate: vi.fn(),
  invalidateCaches: vi.fn(),
  modes: vi.fn(),
  objects: vi.fn(),
  contractorIds: vi.fn(),
  frozen: vi.fn(),
  hours: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  withTransaction: async (fn: (client: { query: typeof h.clientQuery }) => Promise<unknown>) =>
    fn({ query: h.clientQuery }),
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: h.invalidateCaches }));
vi.mock('./audit.service.js', () => ({
  AUDIT_ACTIONS: {
    TIMESHEET_OBJECT_SELF_SELECTED: 'TIMESHEET_OBJECT_SELF_SELECTED',
    TIMESHEET_OBJECT_MANAGER_SELECTED: 'TIMESHEET_OBJECT_MANAGER_SELECTED',
  },
  auditService: { logFromRequestWithClient: h.audit },
}));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { invalidate: h.invalidate } }));
vi.mock('./timesheet-export-mode.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./timesheet-export-mode.service.js')>()),
  resolveExportModes: h.modes,
}));
vi.mock('./employee-timesheet-object.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./employee-timesheet-object.service.js')>()),
  loadSkudObjects: h.objects,
  loadContractorDepartmentIds: h.contractorIds,
  isPreviousMonthFrozen: h.frozen,
  loadTimesheetObjectHours: h.hours,
}));

const {
  TimesheetObjectError,
  buildAllObjectOptions,
  buildHoursOptions,
  canChangeTimesheetObject,
  getTimesheetObjectState,
  setTimesheetObject,
} = await import('./employee-timesheet-object-choice.service.js');

const msk = (iso: string): Date => new Date(`${iso}+03:00`);
const IN_WINDOW = msk('2026-09-29T12:00:00');
const OUT_OF_WINDOW = msk('2026-09-15T12:00:00');

const OBJECTS = new Map([
  ['o-polk', { id: 'o-polk', name: 'Офис Полковая', alt_name: 'Текущая деятельность', is_active: true }],
  ['o-dom', { id: 'o-dom', name: 'ЖК Дом 56', alt_name: null, is_active: true }],
  ['o-zil', { id: 'o-zil', name: 'ЖК Зил 18,19,27', alt_name: null, is_active: true }],
  ['o-city', { id: 'o-city', name: 'ЖК Ситибэй', alt_name: null, is_active: true }],
  ['o-old', { id: 'o-old', name: 'Архивный', alt_name: null, is_active: false }],
]);

const req = { user: { id: 'user-1', employee_id: 100 } } as never;

const employeeRow = (over: Record<string, unknown> = {}) => ({
  id: 815, full_name: 'Кенгашев Улмас', employment_status: 'active', is_archived: false,
  org_department_id: 'dept-own', ...over,
});

/** Кенгашев: Дом 56 — 200 ч, ЗИЛ — 30 ч, Ситибэй — 20 ч. */
const KENGASHEV_HOURS = [
  { value: 'o-dom', label: 'ЖК Дом 56', objectId: 'o-dom', hours: 200 },
  { value: 'o-zil', label: 'ЖК Зил 18,19,27', objectId: 'o-zil', hours: 30 },
  { value: 'o-city', label: 'ЖК Ситибэй', objectId: 'o-city', hours: 20 },
];

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.queryOne.mockResolvedValue(employeeRow());
  h.objects.mockResolvedValue(OBJECTS);
  h.contractorIds.mockResolvedValue(['dept-contractor']);
  h.frozen.mockResolvedValue(true);
  h.modes.mockResolvedValue(new Map([[815, { mode: 'object', pinnedObjectId: 'o-dom', source: 'employee_explicit' }]]));
  h.hours.mockResolvedValue(new Map([[815, KENGASHEV_HOURS]]));
  h.clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FOR UPDATE')) {
      return { rows: [{ timesheet_export_mode: 'object', timesheet_export_object_id: 'o-dom', timesheet_export_set_by: 'auto' }] };
    }
    return { rows: [] };
  });
});

describe('canChangeTimesheetObject', () => {
  const base = { eligible: true, previousMonthFrozen: true, windowOpen: true, hasObject: true };
  it('в окне — и сотрудник, и ведущий табель', () => {
    expect(canChangeTimesheetObject({ ...base, actor: 'employee' })).toBe(true);
    expect(canChangeTimesheetObject({ ...base, actor: 'manager' })).toBe(true);
  });
  it('вне окна — только ведущий табель и только новичку без объекта', () => {
    const closed = { ...base, windowOpen: false };
    expect(canChangeTimesheetObject({ ...closed, actor: 'employee', hasObject: false })).toBe(false);
    expect(canChangeTimesheetObject({ ...closed, actor: 'manager', hasObject: true })).toBe(false);
    expect(canChangeTimesheetObject({ ...closed, actor: 'manager', hasObject: false })).toBe(true);
  });
  it('прошлый месяц не зафиксирован или не свой работающий — никогда', () => {
    expect(canChangeTimesheetObject({ ...base, actor: 'manager', previousMonthFrozen: false })).toBe(false);
    expect(canChangeTimesheetObject({ ...base, actor: 'manager', eligible: false, hasObject: false })).toBe(false);
  });
});

describe('список выбора — больше 24 ч с 1-го числа + текущий', () => {
  it('Дом 56 (200 ч, текущий) и ЗИЛ (30 ч); Ситибэй (20 ч) — нет', () => {
    expect(buildHoursOptions(KENGASHEV_HOURS, { value: 'o-dom', label: 'ЖК Дом 56' }).map(o => o.value))
      .toEqual(['o-dom', 'o-zil']);
  });

  it('ровно 24 ч — нет, 24,5 ч — есть', () => {
    const list = [
      { value: 'o-zil', label: 'ЗИЛ', hours: 24 },
      { value: 'o-city', label: 'Ситибэй', hours: 24.5 },
    ];
    expect(buildHoursOptions(list, { value: null, label: null }).map(o => o.value)).toEqual(['o-city']);
  });

  it('текущий объект в списке, даже если часов мало или нет вовсе', () => {
    expect(buildHoursOptions([{ value: 'o-dom', label: 'ЖК Дом 56', hours: 10 }], { value: 'o-dom', label: 'ЖК Дом 56' }))
      .toEqual([{ value: 'o-dom', label: 'ЖК Дом 56' }]);
    expect(buildHoursOptions([], { value: 'office', label: 'Офис' })).toEqual([{ value: 'office', label: 'Офис' }]);
  });

  it('все объекты новичку: «Офис» одним пунктом, неактивных нет', () => {
    expect(buildAllObjectOptions(OBJECTS)).toEqual([
      { value: 'office', label: 'Офис' },
      { value: 'o-dom', label: 'ЖК Дом 56' },
      { value: 'o-zil', label: 'ЖК Зил 18,19,27' },
      { value: 'o-city', label: 'ЖК Ситибэй' },
    ]);
  });
});

describe('getTimesheetObjectState', () => {
  it('вне окна — только подпись, список не считается', async () => {
    const state = await getTimesheetObjectState(815, 'employee', OUT_OF_WINDOW);
    expect(state).toEqual({ label: 'ЖК Дом 56', value: 'o-dom', can_change: false, options: [] });
    expect(h.hours).not.toHaveBeenCalled();
  });

  it('в окне — список по часам текущего месяца (с 1-го по сегодня)', async () => {
    const state = await getTimesheetObjectState(815, 'employee', IN_WINDOW);
    expect(state.can_change).toBe(true);
    expect(state.options.map(o => o.label)).toEqual(['ЖК Дом 56', 'ЖК Зил 18,19,27']);
    expect(h.hours).toHaveBeenCalledWith([815], { start: '2026-09-01', end: '2026-09-29' }, expect.any(Object));
  });

  it('новичок без объекта: ведущему табель — все объекты в любой день', async () => {
    h.modes.mockResolvedValue(new Map([[815, { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }]]));
    const state = await getTimesheetObjectState(815, 'manager', OUT_OF_WINDOW);
    expect(state.can_change).toBe(true);
    expect(state.options.map(o => o.value)).toEqual(['office', 'o-dom', 'o-zil', 'o-city']);
  });

  it('подрядчик — менять нельзя', async () => {
    h.queryOne.mockResolvedValue(employeeRow({ org_department_id: 'dept-contractor' }));
    const state = await getTimesheetObjectState(815, 'manager', IN_WINDOW);
    expect(state.can_change).toBe(false);
  });
});

describe('setTimesheetObject', () => {
  it('сотрудник выбирает ЗИЛ в окне: set_by = employee, аудит, сброс кэшей', async () => {
    const result = await setTimesheetObject(req, 815, 'o-zil', 'employee', IN_WINDOW);
    expect(result.changed).toBe(true);
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE employees'));
    expect(update?.[1]).toEqual(['object', 'o-zil', 'employee', 815]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(), req, 'user-1', 'TIMESHEET_OBJECT_SELF_SELECTED',
      expect.objectContaining({ entityId: '815' }),
    );
    expect(h.invalidate).toHaveBeenCalledWith(815);
    expect(h.invalidateCaches).toHaveBeenCalled();
    // Лок режимов — тот же ключ, что у админских путей и ночного расчёта.
    expect(h.clientQuery.mock.calls[0]?.[1]).toEqual([249_0001]);
  });

  it('выбор того же объекта при авто — закрепляет источник (set_by = employee)', async () => {
    const result = await setTimesheetObject(req, 815, 'o-dom', 'employee', IN_WINDOW);
    expect(result.changed).toBe(true);
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE employees'));
    expect(update?.[1]).toEqual(['object', 'o-dom', 'employee', 815]);
  });

  it('повтор того же выбора тем же источником — без UPDATE и аудита', async () => {
    h.clientQuery.mockImplementation(async (sql: string) => (sql.includes('FOR UPDATE')
      ? { rows: [{ timesheet_export_mode: 'object', timesheet_export_object_id: 'o-zil', timesheet_export_set_by: 'employee' }] }
      : { rows: [] }));
    h.modes.mockResolvedValue(new Map([[815, { mode: 'object', pinnedObjectId: 'o-zil', source: 'employee_explicit' }]]));
    const result = await setTimesheetObject(req, 815, 'o-zil', 'employee', IN_WINDOW);
    expect(result.changed).toBe(false);
    expect(h.clientQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE employees'))).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('ведущий табель выбирает «Офис»: current_activity, set_by = manager', async () => {
    h.hours.mockResolvedValue(new Map([[815, [
      { value: 'office', label: 'Офис', objectId: null, hours: 40 },
      ...KENGASHEV_HOURS,
    ]]]));
    await setTimesheetObject(req, 815, 'office', 'manager', IN_WINDOW);
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE employees'));
    expect(update?.[1]).toEqual(['current_activity', null, 'manager', 815]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(), req, 'user-1', 'TIMESHEET_OBJECT_MANAGER_SELECTED', expect.anything(),
    );
  });

  it('Ситибэй (20 ч) выбрать нельзя — 400 TIMESHEET_OBJECT_NOT_ALLOWED', async () => {
    await expect(setTimesheetObject(req, 815, 'o-city', 'employee', IN_WINDOW)).rejects.toMatchObject({
      status: 400, code: 'TIMESHEET_OBJECT_NOT_ALLOWED',
    });
  });

  it('вне окна — 409; прошлый месяц не зафиксирован — 409; подрядчик — 400', async () => {
    await expect(setTimesheetObject(req, 815, 'o-zil', 'employee', OUT_OF_WINDOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OBJECT_WINDOW_CLOSED',
    });
    await expect(setTimesheetObject(req, 815, 'o-zil', 'manager', OUT_OF_WINDOW)).rejects.toBeInstanceOf(TimesheetObjectError);

    h.frozen.mockResolvedValue(false);
    await expect(setTimesheetObject(req, 815, 'o-zil', 'employee', IN_WINDOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OBJECT_PREVIOUS_MONTH_NOT_FROZEN',
    });

    h.frozen.mockResolvedValue(true);
    h.queryOne.mockResolvedValue(employeeRow({ org_department_id: 'dept-contractor' }));
    await expect(setTimesheetObject(req, 815, 'o-zil', 'manager', IN_WINDOW)).rejects.toMatchObject({
      status: 400, code: 'TIMESHEET_OBJECT_NOT_ELIGIBLE',
    });
  });

  it('новичку без объекта ведущий табель ставит первый объект вне окна', async () => {
    h.modes.mockResolvedValue(new Map([[815, { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }]]));
    h.clientQuery.mockImplementation(async (sql: string) => (sql.includes('FOR UPDATE')
      ? { rows: [{ timesheet_export_mode: null, timesheet_export_object_id: null, timesheet_export_set_by: null }] }
      : { rows: [] }));
    const result = await setTimesheetObject(req, 815, 'o-city', 'manager', OUT_OF_WINDOW);
    expect(result.changed).toBe(true);
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE employees'));
    expect(update?.[1]).toEqual(['object', 'o-city', 'manager', 815]);
  });
});
