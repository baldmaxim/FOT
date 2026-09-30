import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Выбор объекта табелирования вручную (миграция 288): сотрудник в ЛК и тот, кто ведёт
 * табель. Два объекта с наибольшими часами и разница меньше 15 %, окно последних 3 дней,
 * исключение для новичка, повтор без записи, блокировка «Офисом» из окна (291).
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
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
  locked: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
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
vi.mock('./timesheet-office-rule.js', () => ({ isTimesheetOfficeLocked: h.locked }));

const {
  TimesheetObjectError,
  buildAllObjectOptions,
  buildHoursOptions,
  canChangeTimesheetObject,
  getTimesheetObjectState,
  hasAlternativeOption,
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
  ['o-metro', { id: 'o-metro', name: 'ЖК Метрополия', alt_name: null, is_active: true }],
  ['o-old', { id: 'o-old', name: 'Архивный', alt_name: null, is_active: false }],
]);

const req = { user: { id: 'user-1', employee_id: 100 } } as never;

const employeeRow = (over: Record<string, unknown> = {}) => ({
  id: 815, full_name: 'Кенгашев Улмас', employment_status: 'active', is_archived: false,
  org_department_id: 'dept-own', ...over,
});

/** Кенгашев: Дом 56 — 100 ч, ЗИЛ — 90 ч (разница 10 %), Ситибэй — 20 ч. */
const KENGASHEV_HOURS = [
  { value: 'o-dom', label: 'ЖК Дом 56', objectId: 'o-dom', hours: 100 },
  { value: 'o-zil', label: 'ЖК Зил 18,19,27', objectId: 'o-zil', hours: 90 },
  { value: 'o-city', label: 'ЖК Ситибэй', objectId: 'o-city', hours: 20 },
];

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.queryOne.mockResolvedValue(employeeRow());
  h.query.mockResolvedValue([]);
  h.objects.mockResolvedValue(OBJECTS);
  h.contractorIds.mockResolvedValue(['dept-contractor']);
  h.frozen.mockResolvedValue(true);
  h.modes.mockResolvedValue(new Map([[815, { mode: 'object', pinnedObjectId: 'o-dom', source: 'employee_explicit' }]]));
  h.hours.mockResolvedValue(new Map([[815, KENGASHEV_HOURS]]));
  h.locked.mockResolvedValue(false);
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
  it('«Офис» из окна «Режим табелирования» — никому, ни в окне, ни новичку', () => {
    expect(canChangeTimesheetObject({ ...base, actor: 'employee', locked: true })).toBe(false);
    expect(canChangeTimesheetObject({ ...base, actor: 'manager', locked: true })).toBe(false);
    expect(canChangeTimesheetObject({ ...base, actor: 'manager', windowOpen: false, hasObject: false, locked: true }))
      .toBe(false);
  });
});

describe('список выбора — два лучших по часам, разница меньше 15 % от большего', () => {
  const pair = (first: number, second: number) => [
    { value: 'o-metro', label: 'ЖК Метрополия', hours: first },
    { value: 'o-zil', label: 'ЖК Зил 18,19,27', hours: second },
    { value: 'o-city', label: 'ЖК Ситибэй', hours: 5 },
  ];

  it('100 ч и 86 ч (14 %) — можно любой из двух; третий — нет', () => {
    expect(buildHoursOptions(pair(100, 86), { value: 'o-metro', label: 'ЖК Метрополия' }).map(o => o.value))
      .toEqual(['o-metro', 'o-zil']);
  });

  it('100 ч и 85 ч (ровно 15 %) — выбора нет, только первый', () => {
    expect(buildHoursOptions(pair(100, 85), { value: 'o-metro', label: 'ЖК Метрополия' }).map(o => o.value))
      .toEqual(['o-metro']);
  });

  it('равные часы — оба; один объект — только он', () => {
    expect(buildHoursOptions(pair(50, 50), { value: null, label: null }).map(o => o.value)).toEqual(['o-metro', 'o-zil']);
    expect(buildHoursOptions([{ value: 'o-dom', label: 'ЖК Дом 56', hours: 10 }], { value: null, label: null }))
      .toEqual([{ value: 'o-dom', label: 'ЖК Дом 56' }]);
  });

  it('текущий вне двух лучших — в списке для показа; нет часов — только текущий', () => {
    expect(buildHoursOptions(pair(100, 50), { value: 'o-city', label: 'ЖК Ситибэй' }).map(o => o.value))
      .toEqual(['o-metro', 'o-city']);
    expect(buildHoursOptions([], { value: 'office', label: 'Офис' })).toEqual([{ value: 'office', label: 'Офис' }]);
  });

  it('есть ли на что сменить', () => {
    expect(hasAlternativeOption([{ value: 'o-dom', label: 'ЖК Дом 56' }], 'o-dom')).toBe(false);
    expect(hasAlternativeOption([{ value: 'o-dom', label: 'ЖК Дом 56' }], null)).toBe(true);
    expect(hasAlternativeOption([], null)).toBe(false);
  });

  it('все объекты новичку: «Офис» одним пунктом, неактивных нет', () => {
    expect(buildAllObjectOptions(OBJECTS)).toEqual([
      { value: 'office', label: 'Офис' },
      { value: 'o-dom', label: 'ЖК Дом 56' },
      { value: 'o-zil', label: 'ЖК Зил 18,19,27' },
      { value: 'o-metro', label: 'ЖК Метрополия' },
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

  it('в окне — два лучших по часам текущего месяца (с 1-го по сегодня)', async () => {
    const state = await getTimesheetObjectState(815, 'employee', IN_WINDOW);
    expect(state.can_change).toBe(true);
    expect(state.options.map(o => o.label)).toEqual(['ЖК Дом 56', 'ЖК Зил 18,19,27']);
    expect(h.hours).toHaveBeenCalledWith([815], { start: '2026-09-01', end: '2026-09-29' }, expect.any(Object));
  });

  it('в окне, но второй отстаёт на 15 % и больше — выбора нет, только текст', async () => {
    h.hours.mockResolvedValue(new Map([[815, [
      { value: 'o-dom', label: 'ЖК Дом 56', objectId: 'o-dom', hours: 200 },
      { value: 'o-zil', label: 'ЖК Зил 18,19,27', objectId: 'o-zil', hours: 30 },
    ]]]));
    const state = await getTimesheetObjectState(815, 'employee', IN_WINDOW);
    expect(state).toEqual({ label: 'ЖК Дом 56', value: 'o-dom', can_change: false, options: [] });
  });

  it('текущий выбран вручную вне двух лучших — можно вернуть первый', async () => {
    h.modes.mockResolvedValue(new Map([[815, { mode: 'object', pinnedObjectId: 'o-metro', source: 'employee_explicit' }]]));
    h.hours.mockResolvedValue(new Map([[815, [
      { value: 'o-dom', label: 'ЖК Дом 56', objectId: 'o-dom', hours: 200 },
      { value: 'o-metro', label: 'ЖК Метрополия', objectId: 'o-metro', hours: 16 },
    ]]]));
    const state = await getTimesheetObjectState(815, 'employee', IN_WINDOW);
    expect(state.can_change).toBe(true);
    expect(state.options.map(o => o.value)).toEqual(['o-dom', 'o-metro']);
  });

  it('«Офис» из окна «Режим табелирования» — только подпись, список не считается', async () => {
    h.locked.mockResolvedValue(true);
    h.modes.mockResolvedValue(new Map([[815, { mode: 'current_activity', pinnedObjectId: null, source: 'employee_explicit' }]]));
    const employee = await getTimesheetObjectState(815, 'employee', IN_WINDOW);
    const manager = await getTimesheetObjectState(815, 'manager', OUT_OF_WINDOW);
    expect(employee).toEqual({ label: 'Офис', value: 'office', can_change: false, options: [] });
    expect(manager).toEqual({ label: 'Офис', value: 'office', can_change: false, options: [] });
    expect(h.hours).not.toHaveBeenCalled();
  });

  it('новичок без объекта: ведущему табель — все объекты в любой день', async () => {
    h.modes.mockResolvedValue(new Map([[815, { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }]]));
    const state = await getTimesheetObjectState(815, 'manager', OUT_OF_WINDOW);
    expect(state.can_change).toBe(true);
    expect(state.options.map(o => o.value)).toEqual(['office', 'o-dom', 'o-zil', 'o-metro', 'o-city']);
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
    expect(update?.[1]).toEqual(['object', 'o-zil', 'employee', 815, 'user-1']);
    // Автор и новая дата (289): без даты триггер счёл бы запись не человеческой.
    expect(String(update?.[0])).toContain('timesheet_export_set_by_user_id = $5::uuid');
    expect(String(update?.[0])).toContain('timesheet_export_set_at = now()');
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
    expect(update?.[1]).toEqual(['object', 'o-dom', 'employee', 815, 'user-1']);
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
      { value: 'office', label: 'Офис', objectId: null, hours: 105 },
      ...KENGASHEV_HOURS,
    ]]]));
    await setTimesheetObject(req, 815, 'office', 'manager', IN_WINDOW);
    const update = h.clientQuery.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE employees'));
    expect(update?.[1]).toEqual(['current_activity', null, 'manager', 815, 'user-1']);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(), req, 'user-1', 'TIMESHEET_OBJECT_MANAGER_SELECTED', expect.anything(),
    );
  });

  it('Ситибэй (третий по часам) выбрать нельзя — 400 TIMESHEET_OBJECT_NOT_ALLOWED', async () => {
    await expect(setTimesheetObject(req, 815, 'o-city', 'employee', IN_WINDOW)).rejects.toMatchObject({
      status: 400, code: 'TIMESHEET_OBJECT_NOT_ALLOWED',
    });
  });

  it('выбора нет (разница 15 % и больше) — даже текущий не закрепить: 400', async () => {
    h.hours.mockResolvedValue(new Map([[815, [
      { value: 'o-dom', label: 'ЖК Дом 56', objectId: 'o-dom', hours: 100 },
      { value: 'o-zil', label: 'ЖК Зил 18,19,27', objectId: 'o-zil', hours: 85 },
    ]]]));
    await expect(setTimesheetObject(req, 815, 'o-zil', 'employee', IN_WINDOW)).rejects.toMatchObject({
      status: 400, code: 'TIMESHEET_OBJECT_NOT_ALLOWED',
    });
    await expect(setTimesheetObject(req, 815, 'o-dom', 'employee', IN_WINDOW)).rejects.toMatchObject({
      status: 400, code: 'TIMESHEET_OBJECT_NOT_ALLOWED',
    });
    expect(h.clientQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE employees'))).toBe(false);
  });

  it('«Офис» из окна — 409 TIMESHEET_OBJECT_LOCKED и сотруднику, и ведущему табель', async () => {
    h.locked.mockResolvedValue(true);
    await expect(setTimesheetObject(req, 815, 'o-zil', 'employee', IN_WINDOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OBJECT_LOCKED',
    });
    await expect(setTimesheetObject(req, 815, 'o-zil', 'manager', IN_WINDOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OBJECT_LOCKED',
    });
    expect(h.clientQuery).not.toHaveBeenCalled();
  });

  it('«Офис» поставили в окне между чтением и записью — 409 из транзакции, без UPDATE и аудита', async () => {
    // Вне транзакции (без клиента) — ещё не закрыт, под локом (с клиентом) — уже закрыт.
    h.locked.mockImplementation(async (_id: number, exec?: unknown) => exec !== undefined);
    await expect(setTimesheetObject(req, 815, 'o-zil', 'employee', IN_WINDOW)).rejects.toMatchObject({
      status: 409, code: 'TIMESHEET_OBJECT_LOCKED',
    });
    expect(h.clientQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE employees'))).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.locked).toHaveBeenLastCalledWith(815, expect.objectContaining({ query: h.clientQuery }));
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
    expect(update?.[1]).toEqual(['object', 'o-city', 'manager', 815, 'user-1']);
  });
});
