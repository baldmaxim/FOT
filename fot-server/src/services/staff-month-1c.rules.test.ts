import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  aggregateBrigades,
  aggregateFact,
  decodeStaffMonthCursor,
  encodeStaffMonthCursor,
  halfNorm,
  matchesFilters,
  normalizeParts,
  OFFICE_OBJECT,
  pageAfter,
  pickEmployeeBrigade,
  pickLatestVersion,
  pickMainKnownKey,
  sameFilters,
  staffMonthHalfBounds,
  timesheetObjectOf,
  UNKNOWN_OBJECT,
  type IApiObject,
  type IDayRecord,
  type IStaffMonthFilters,
} from './staff-month-1c.rules.js';
import { monthBoundsOf } from './staff-month-1c.load.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const dict = new Map<string, IApiObject>([
  [A, { key: A, id: A, name: 'ЖК Ситибэй', address: null }],
  [B, { key: B, id: B, name: 'ЖК Примавера К14', address: null }],
]);

const day = (over: Partial<IDayRecord>): IDayRecord => ({
  date: '2026-10-01', source: 'closed', status: 'work', timesheetCenti: 1000, parts: [{ key: A, centi: 1000 }],
  worked: true, versionId: 1, departmentId: null, frozen: true, preliminary: false, ...over,
});

const NO_FILTERS: IStaffMonthFilters = { half: null, object_key: null, category: null, employee_id: null, days: false, export_state: null };

describe('staff-month-1c.rules', () => {
  it('пара в двух подачах: поздний created_at, затем больший id', () => {
    expect(pickLatestVersion([
      { versionId: 5, createdAt: '2026-10-16T10:00:00.000000' },
      { versionId: 3, createdAt: '2026-10-17T09:00:00.000000' },
    ])?.versionId).toBe(3);
    expect(pickLatestVersion([
      { versionId: 5, createdAt: '2026-10-16T10:00:00.000000' },
      { versionId: 7, createdAt: '2026-10-16T10:00:00.000000' },
    ])?.versionId).toBe(7);
  });

  it('части дня: Σ = часам дня, остаток и отсутствие разбивки — в «Не определён»', () => {
    expect(normalizeParts(1000, [{ key: A, centi: 600 }, { key: B, centi: 400 }])).toEqual([
      { key: A, centi: 600 }, { key: B, centi: 400 },
    ]);
    expect(normalizeParts(1000, [{ key: A, centi: 700 }])).toEqual([{ key: A, centi: 700 }, { key: 'unknown', centi: 300 }]);
    expect(normalizeParts(1000, [])).toEqual([{ key: 'unknown', centi: 1000 }]);
    expect(normalizeParts(1000, [{ key: A, centi: 1200 }])).toEqual([{ key: 'unknown', centi: 1000 }]);
    expect(normalizeParts(0, [{ key: A, centi: 100 }])).toEqual([]);
  });

  it('факт — только отработанные дни; неявка с часами нормы в факт не входит', () => {
    const fact = aggregateFact([
      day({}),
      day({ date: '2026-10-02', status: 'vacation', worked: false, parts: [{ key: A, centi: 800 }], timesheetCenti: 800 }),
      day({ date: '2026-10-03', source: 'live', parts: [{ key: B, centi: 550 }], timesheetCenti: 550, frozen: false, preliminary: true }),
    ]);
    expect(fact.factCenti).toBe(1550);
    expect(Object.fromEntries(fact.factByObject)).toEqual({ [A]: 1000, [B]: 550 });
    expect(fact.liveDays).toBe(1);
    expect(fact.preliminary).toBe(true);
    expect(fact.frozen).toBe(false);
  });

  it('основной объект бригады — наибольшие часы, «Не определён» не выбирается, ничья — по имени', () => {
    expect(pickMainKnownKey(new Map([['unknown', 5000], [A, 100], [B, 200]]), dict)).toBe(B);
    expect(pickMainKnownKey(new Map([['unknown', 5000]]), dict)).toBeNull();
    // Ничья: «ЖК Примавера К14» раньше «ЖК Ситибэй».
    expect(pickMainKnownKey(new Map([[A, 100], [B, 100]]), dict)).toBe(B);
  });

  it('бригады: члены и объекты из дней; бригада сотрудника — больше часов, затем дней, затем имя', () => {
    const brigades = aggregateBrigades([
      { departmentId: 'b1', employeeId: 7, date: '2026-10-01', parts: [{ key: A, centi: 1000 }] },
      { departmentId: 'b1', employeeId: 7, date: '2026-10-02', parts: [{ key: B, centi: 300 }] },
      { departmentId: 'b2', employeeId: 7, date: '2026-10-20', parts: [{ key: A, centi: 1300 }] },
      { departmentId: 'b2', employeeId: 8, date: '2026-10-20', parts: [{ key: A, centi: 500 }] },
    ]);
    expect(Object.fromEntries(brigades.get('b1')!.byObject)).toEqual({ [A]: 1000, [B]: 300 });
    expect(brigades.get('b2')!.members.get(8)).toEqual({ centi: 500, days: 1 });
    const names = new Map([['b1', 'бр.Амонов'], ['b2', 'бр.Жабаров']]);
    // 13 ч и 13 ч: у b1 два дня против одного.
    expect(pickEmployeeBrigade(7, brigades, id => names.get(id)!)).toBe('b1');
    expect(pickEmployeeBrigade(99, brigades, id => names.get(id)!)).toBeNull();
  });

  it('отбор: объект — основной или факт на нём; категория; сотрудник', () => {
    const row = { employee_id: 5, category: 'worker' as const, mainKey: A, factByObject: new Map([[B, 100]]) };
    expect(matchesFilters(row, { ...NO_FILTERS, object_key: A })).toBe(true);
    expect(matchesFilters(row, { ...NO_FILTERS, object_key: B })).toBe(true);
    expect(matchesFilters(row, { ...NO_FILTERS, object_key: 'office' })).toBe(false);
    expect(matchesFilters(row, { ...NO_FILTERS, category: 'itr' })).toBe(false);
    expect(matchesFilters(row, { ...NO_FILTERS, employee_id: 6 })).toBe(false);
    expect(matchesFilters({ ...row, factByObject: new Map([[B, 0]]) }, { ...NO_FILTERS, object_key: B })).toBe(false);
  });

  it('курсор: подпись, версия, подмена и чужой секрет', () => {
    const cursor = { month: '2026-10', snapshotId: 'snap', filters: { ...NO_FILTERS, object_key: A }, lastEmployeeId: 120 };
    const raw = encodeStaffMonthCursor(cursor, 'secret');
    expect(decodeStaffMonthCursor(raw, 'secret')).toEqual(cursor);
    expect(decodeStaffMonthCursor(raw, 'other')).toBeNull();
    const [body, signature] = raw.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, m: '2026-10', s: 'snap', f: cursor.filters, l: 1 })).toString('base64url');
    expect(decodeStaffMonthCursor(`${forged}.${signature}`, 'secret')).toBeNull();
    expect(decodeStaffMonthCursor(body, 'secret')).toBeNull();
    expect(decodeStaffMonthCursor('мусор', 'secret')).toBeNull();
    expect(sameFilters(cursor.filters, { ...cursor.filters, days: true })).toBe(false);
    expect(sameFilters(cursor.filters, { ...cursor.filters, export_state: ['ready', 'changed'] })).toBe(false);
    expect(sameFilters(cursor.filters, { ...cursor.filters, half: 1 })).toBe(false);
    expect(sameFilters({ ...cursor.filters, half: 2 }, { ...cursor.filters, half: 2 })).toBe(true);
    // Курсор v1 (до половин) с настоящей подписью — отклоняется: обход начинается заново.
    const v1 = Buffer.from(JSON.stringify({ v: 1, m: '2026-10', s: 'snap', f: cursor.filters, l: 120 })).toString('base64url');
    const v1Signed = `${v1}.${createHmac('sha256', 'secret').update(v1).digest('base64url')}`;
    expect(decodeStaffMonthCursor(v1Signed, 'secret')).toBeNull();
  });

  it('половины: границы как у подач табеля (28/29/30/31), началась и закончилась по Москве', () => {
    const past = (month: string) => monthBoundsOf(month, new Date('2028-06-01T09:00:00Z'));
    expect(staffMonthHalfBounds(past('2027-02'), 2)).toMatchObject({ from: '2027-02-16', to: '2027-02-28', started: true, ended: true });
    expect(staffMonthHalfBounds(past('2028-02'), 2)).toMatchObject({ to: '2028-02-29' });
    expect(staffMonthHalfBounds(past('2026-11'), 2)).toMatchObject({ from: '2026-11-16', to: '2026-11-30', until: '2026-11-30' });
    expect(staffMonthHalfBounds(past('2026-10'), 1)).toMatchObject({ from: '2026-10-01', to: '2026-10-15', until: '2026-10-15', ended: true });
    // Текущий месяц: 15-е — первая половина идёт (табель 1–15 могли закрыть днём), вторая не началась.
    const on15 = monthBoundsOf('2026-11', new Date('2026-11-15T20:00:00Z'));
    expect(staffMonthHalfBounds(on15, 1)).toMatchObject({ started: true, ended: false, until: '2026-11-15' });
    expect(staffMonthHalfBounds(on15, 2)).toMatchObject({ started: false, ended: false });
    // 16-е по Москве (15.11 21:30 UTC): первая закончилась, вторая идёт.
    const on16 = monthBoundsOf('2026-11', new Date('2026-11-15T21:30:00Z'));
    expect(staffMonthHalfBounds(on16, 1)).toMatchObject({ ended: true });
    expect(staffMonthHalfBounds(on16, 2)).toMatchObject({ started: true, ended: false, until: '2026-11-16' });
    // Последний день месяца — вторая половина ещё идёт.
    expect(staffMonthHalfBounds(monthBoundsOf('2026-11', new Date('2026-11-30T12:00:00Z')), 2)).toMatchObject({ ended: false });
  });

  it('норма половины: Σ плановых часов, рабочие дни; день без графика — null, не ноль', () => {
    const days = [
      { plan_hours: 8, working_day: true },
      { plan_hours: 7, working_day: true },
      { plan_hours: 0, working_day: false },
    ];
    expect(halfNorm(days)).toEqual({ hours: 15, days: 2, complete: true });
    expect(halfNorm([...days, { plan_hours: null, working_day: null }])).toEqual({ hours: null, days: null, complete: false });
    expect(halfNorm([])).toEqual({ hours: null, days: null, complete: false });
  });

  it('объект табелирования: объект, «Офис» (режим и адрес), по СКУД, пропавший объект', () => {
    const lookup = (id: string) => (id === A
      ? { object: dict.get(A)!, address: 'ул. Ситибэй, 1' }
      : id === B ? { object: dict.get(B)!, address: ' Текущая деятельность ' } : null);
    expect(timesheetObjectOf({ mode: 'object', pinnedObjectId: A }, lookup)).toEqual({ mode: 'object', object: dict.get(A) });
    expect(timesheetObjectOf({ mode: 'object', pinnedObjectId: B }, lookup)).toEqual({ mode: 'office', object: OFFICE_OBJECT });
    expect(timesheetObjectOf({ mode: 'current_activity', pinnedObjectId: null }, lookup)).toEqual({ mode: 'office', object: OFFICE_OBJECT });
    expect(timesheetObjectOf({ mode: 'skud', pinnedObjectId: null }, lookup)).toEqual({ mode: 'skud', object: null });
    expect(timesheetObjectOf({ mode: 'object', pinnedObjectId: 'gone' }, lookup)).toEqual({ mode: 'object', object: UNKNOWN_OBJECT });
    expect(timesheetObjectOf({ mode: 'object', pinnedObjectId: null }, lookup)).toEqual({ mode: 'object', object: UNKNOWN_OBJECT });
    expect(timesheetObjectOf(undefined, lookup)).toEqual({ mode: 'skud', object: null });
  });

  it('страницы: обход до конца без дублей и пропусков', () => {
    const rows = [3, 5, 8, 13, 21].map(id => ({ employee_id: id }));
    const seen: number[] = [];
    let after: number | null = null;
    for (;;) {
      const { page, hasMore } = pageAfter(rows, after, 2);
      seen.push(...page.map(row => row.employee_id));
      if (!hasMore) break;
      after = page[page.length - 1].employee_id;
    }
    expect(seen).toEqual([3, 5, 8, 13, 21]);
  });
});
