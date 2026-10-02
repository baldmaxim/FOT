import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Объект табелирования (миграция 288): группа «Офис», границы месяцев, часы по объектам
 * табелирования, подписи.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));
vi.mock('../config/contractor.js', () => ({ getContractorRootId: vi.fn(async () => 'root') }));
vi.mock('./attendance.service.js', () => ({ loadAttendanceAdjustments: vi.fn(async () => []) }));
vi.mock('./timesheet-object.service.js', () => ({ buildObjectAttendanceData: vi.fn() }));

const {
  OFFICE_LABEL,
  OFFICE_VALUE,
  canonicalizeMode,
  groupObjectHours,
  isOfficeAddress,
  isWorkerSkudMode,
  labelForResolved,
  loadContractorDepartmentIds,
  loadTimesheetObjectLabels,
  monthEnd,
  previousMonthStartMsk,
  workerObjectsLabel,
} = await import('./employee-timesheet-object.service.js');
const contractor = await import('../config/contractor.js');

/** МСК = UTC+3. */
const msk = (iso: string): Date => new Date(`${iso}+03:00`);

const objects = new Map([
  ['o-polk', { id: 'o-polk', name: 'Офис Полковая', alt_name: 'Текущая деятельность', is_active: true }],
  ['o-polk3', { id: 'o-polk3', name: 'Офис Полковая 3', alt_name: ' текущая деятельность ', is_active: true }],
  ['o-it', { id: 'o-it', name: 'ИТ', alt_name: 'Текущая деятельность', is_active: true }],
  ['o-dom', { id: 'o-dom', name: 'ЖК Дом 56', alt_name: 'Фридриха Энгельса ул.', is_active: true }],
  ['o-zil', { id: 'o-zil', name: 'ЖК Зил 18,19,27', alt_name: null, is_active: true }],
  ['o-old', { id: 'o-old', name: 'Закрытый объект', alt_name: null, is_active: false }],
]);

beforeEach(() => {
  pgQuery.mockReset().mockResolvedValue([]);
});

describe('группа «Офис»', () => {
  it('офис — объект с 1С-адресом «Текущая деятельность», без учёта регистра и пробелов', () => {
    expect(isOfficeAddress('Текущая деятельность')).toBe(true);
    expect(isOfficeAddress('  ТЕКУЩАЯ деятельность ')).toBe(true);
    expect(isOfficeAddress('Фридриха Энгельса ул.')).toBe(false);
    expect(isOfficeAddress(null)).toBe(false);
  });

  it('офисный объект не хранится закреплённым — превращается в current_activity', () => {
    expect(canonicalizeMode('object', 'o-polk', objects)).toEqual({ mode: 'current_activity', objectId: null });
    expect(canonicalizeMode('object', 'o-dom', objects)).toEqual({ mode: 'object', objectId: 'o-dom' });
    expect(canonicalizeMode('skud', 'o-dom', objects)).toEqual({ mode: 'skud', objectId: null });
    expect(canonicalizeMode(null, null, objects)).toEqual({ mode: null, objectId: null });
  });
});

describe('границы месяцев по МСК', () => {
  it('прошлый месяц и конец месяца', () => {
    expect(previousMonthStartMsk(msk('2026-10-01T04:00:00'))).toBe('2026-09-01');
    expect(previousMonthStartMsk(msk('2026-01-15T12:00:00'))).toBe('2025-12-01');
    expect(monthEnd('2026-09-01')).toBe('2026-09-30');
    expect(monthEnd('2028-02-01')).toBe('2028-02-29');
  });
});

describe('groupObjectHours — объекты табелирования', () => {
  it('офисы суммируются в «Офис», неактивные объекты не считаются', () => {
    const grouped = groupObjectHours([
      { objectId: 'o-dom', hours: 20 },
      { objectId: 'o-polk', hours: 15 },
      { objectId: 'o-polk3', hours: 12 },
      { objectId: 'o-it', hours: 1.5 },
      { objectId: 'o-old', hours: 100 },
    ], objects);
    expect(grouped).toEqual([
      { value: OFFICE_VALUE, label: OFFICE_LABEL, objectId: null, hours: 28.5 },
      { value: 'o-dom', label: 'ЖК Дом 56', objectId: 'o-dom', hours: 20 },
    ]);
  });

  it('ничья: по названию, затем по значению', () => {
    const grouped = groupObjectHours([
      { objectId: 'o-zil', hours: 10 },
      { objectId: 'o-dom', hours: 10 },
    ], objects);
    expect(grouped.map(item => item.value)).toEqual(['o-dom', 'o-zil']);
  });

  it('нулевые и отрицательные итоги отбрасываются', () => {
    expect(groupObjectHours([{ objectId: 'o-dom', hours: 0 }], objects)).toEqual([]);
  });
});

describe('подписи', () => {
  it('current_activity → «Офис»; объект → имя; офисный объект → «Офис»; skud → null', () => {
    const pinned = (id: string) => ({ mode: 'object' as const, pinnedObjectId: id, source: 'employee_explicit' as const });
    expect(labelForResolved({ mode: 'current_activity', pinnedObjectId: null, source: 'legacy_department' }, objects))
      .toBe(OFFICE_LABEL);
    expect(labelForResolved(pinned('o-dom'), objects)).toBe('ЖК Дом 56');
    expect(labelForResolved(pinned('o-polk'), objects)).toBe(OFFICE_LABEL);
    expect(labelForResolved({ mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }, objects)).toBeNull();
  });
});

describe('подпись рабочего — объекты периода через запятую', () => {
  const skud = (setBy?: 'auto' | 'employee' | 'manager') => ({
    mode: 'skud' as const, pinnedObjectId: null, source: 'employee_explicit' as const, ...(setBy ? { setBy } : {}),
  });
  const entry = (employeeId: number, objectId: string | null, hours: number, name = objectId ?? 'Не определён') => ({
    adjustment_id: null, employee_id: employeeId, work_date: '2026-10-01',
    object_key: objectId ?? 'unknown', object_id: objectId, object_name: name,
    hours_worked: hours, display_hours_worked: hours, base_hours_worked: hours, is_correction: false,
  });

  it('рабочий — только skud от правила (set_by = auto); ручной «По СКУД» и legacy — нет', () => {
    expect(isWorkerSkudMode(skud('auto'))).toBe(true);
    expect(isWorkerSkudMode(skud())).toBe(false);
    expect(isWorkerSkudMode(skud('employee'))).toBe(false);
    expect(isWorkerSkudMode({ mode: 'skud', pinnedObjectId: null, source: 'legacy_default' })).toBe(false);
    expect(isWorkerSkudMode({ mode: 'object', pinnedObjectId: 'o-dom', source: 'employee_explicit', setBy: 'auto' })).toBe(false);
  });

  it('по убыванию часов, офисы одним «Офисом», неактивный объект тоже; часов нет — null', () => {
    expect(workerObjectsLabel([
      { objectId: 'o-zil', hours: 44 },
      { objectId: 'o-old', hours: 3 },
      { objectId: 'o-polk', hours: 2 },
      { objectId: 'o-it', hours: 4 },
      { objectId: 'o-dom', hours: 216 },
      { objectId: 'o-missing', hours: 100 },
    ], objects)).toBe(`ЖК Дом 56, ЖК Зил 18,19,27, ${OFFICE_LABEL}, Закрытый объект`);
    expect(workerObjectsLabel([], objects)).toBeNull();
    expect(workerObjectsLabel(undefined, objects)).toBeNull();
  });

  it('табель: рабочему — объекты из часов периода; остальным — как раньше; без часов табеля — без подписи', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT id::text AS id, name, alt_name, is_active FROM skud_objects')) return [...objects.values()];
      return [
        { employee_id: 1, emp_mode: 'skud', emp_object_id: null, emp_set_by: 'auto', dept_current_activity: false },
        { employee_id: 2, emp_mode: 'skud', emp_object_id: null, emp_set_by: null, dept_current_activity: false },
        { employee_id: 3, emp_mode: 'object', emp_object_id: 'o-dom', emp_set_by: 'auto', dept_current_activity: false },
        { employee_id: 4, emp_mode: null, emp_object_id: null, emp_set_by: null, dept_current_activity: false },
        { employee_id: 5, emp_mode: 'skud', emp_object_id: null, emp_set_by: 'auto', dept_current_activity: false },
      ];
    });
    const objectEntries = [
      entry(1, 'o-zil', 20), entry(1, 'o-zil', 24), entry(1, 'o-dom', 216, 'ЖК Дом 56'), entry(1, null, 7),
      entry(2, 'o-zil', 30), entry(4, 'o-zil', 30),
    ];
    const labels = await loadTimesheetObjectLabels([1, 2, 3, 4, 5], null, { objectEntries });
    expect(Object.fromEntries(labels)).toEqual({ 1: 'ЖК Дом 56, ЖК Зил 18,19,27', 3: 'ЖК Дом 56' });

    const withoutEntries = await loadTimesheetObjectLabels([1, 3]);
    expect(Object.fromEntries(withoutEntries)).toEqual({ 3: 'ЖК Дом 56' });
  });
});

describe('подрядчики', () => {
  it('корень + поддерево; корня нет — ошибка, а не молчаливое включение', async () => {
    pgQuery.mockResolvedValueOnce([{ id: 'root' }, { id: 'child' }]);
    await expect(loadContractorDepartmentIds()).resolves.toEqual(['root', 'child']);

    vi.mocked(contractor.getContractorRootId).mockResolvedValueOnce(null);
    await expect(loadContractorDepartmentIds()).rejects.toThrow('Подрядные организации');
  });
});
