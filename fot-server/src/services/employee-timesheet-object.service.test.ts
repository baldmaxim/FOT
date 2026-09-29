import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Объект табелирования (миграция 288): группа «Офис», окно последних 3 дней, часы по
 * объектам табелирования, подписи.
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
  isTimesheetObjectWindowOpen,
  labelForResolved,
  loadContractorDepartmentIds,
  monthEnd,
  previousMonthStartMsk,
  valueForResolved,
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

describe('окно смены — последние 3 календарных дня месяца по МСК', () => {
  it('30 дней: 28, 29, 30', () => {
    expect(isTimesheetObjectWindowOpen(msk('2026-09-27T23:59:00'))).toBe(false);
    expect(isTimesheetObjectWindowOpen(msk('2026-09-28T00:00:00'))).toBe(true);
    expect(isTimesheetObjectWindowOpen(msk('2026-09-30T23:59:00'))).toBe(true);
  });

  it('31 день: 29, 30, 31', () => {
    expect(isTimesheetObjectWindowOpen(msk('2026-10-28T12:00:00'))).toBe(false);
    expect(isTimesheetObjectWindowOpen(msk('2026-10-29T00:00:00'))).toBe(true);
    expect(isTimesheetObjectWindowOpen(msk('2026-10-31T12:00:00'))).toBe(true);
  });

  it('февраль: 26, 27, 28 (и 27–29 в високосный)', () => {
    expect(isTimesheetObjectWindowOpen(msk('2027-02-25T12:00:00'))).toBe(false);
    expect(isTimesheetObjectWindowOpen(msk('2027-02-26T12:00:00'))).toBe(true);
    expect(isTimesheetObjectWindowOpen(msk('2028-02-26T12:00:00'))).toBe(false);
    expect(isTimesheetObjectWindowOpen(msk('2028-02-27T12:00:00'))).toBe(true);
  });

  it('граница суток — по МСК, а не по UTC', () => {
    // 27.09 22:30 UTC = 28.09 01:30 МСК — окно уже открыто.
    expect(isTimesheetObjectWindowOpen(new Date('2026-09-27T22:30:00Z'))).toBe(true);
    // 30.09 21:30 UTC = 01.10 00:30 МСК — окно закрыто.
    expect(isTimesheetObjectWindowOpen(new Date('2026-09-30T21:30:00Z'))).toBe(false);
  });

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

describe('подписи и значения', () => {
  it('current_activity → «Офис»; объект → имя; офисный объект → «Офис»; skud → null', () => {
    const pinned = (id: string) => ({ mode: 'object' as const, pinnedObjectId: id, source: 'employee_explicit' as const });
    expect(labelForResolved({ mode: 'current_activity', pinnedObjectId: null, source: 'legacy_department' }, objects))
      .toBe(OFFICE_LABEL);
    expect(labelForResolved(pinned('o-dom'), objects)).toBe('ЖК Дом 56');
    expect(labelForResolved(pinned('o-polk'), objects)).toBe(OFFICE_LABEL);
    expect(labelForResolved({ mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }, objects)).toBeNull();
    expect(valueForResolved(pinned('o-polk'), objects)).toBe(OFFICE_VALUE);
    expect(valueForResolved(pinned('o-dom'), objects)).toBe('o-dom');
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
