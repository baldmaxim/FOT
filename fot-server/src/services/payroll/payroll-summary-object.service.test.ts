import { beforeEach, describe, expect, it, vi } from 'vitest';

// «Свод»: объект строки при базовом «Не определён» — режим месяца, затем часы месяца (правило ночного
// объекта табелирования), иначе «Не определён». Базовый объект не трогается.
vi.mock('../../config/postgres.js', () => ({ query: vi.fn() }));

const timesheetObject = vi.hoisted(() => ({
  loadSkudObjects: vi.fn(),
  loadTimesheetObjectHours: vi.fn(),
}));
vi.mock('../employee-timesheet-object.service.js', () => timesheetObject);

import type { IMonthAttribution } from './payroll-month-attribution.service.js';
import { resolveSummaryObjects } from './payroll-summary-object.service.js';

const OBJ_MARK = 'b141b7a4-0000-0000-0000-000000000001';
const OBJ_WAVE = 'b141b7a4-0000-0000-0000-000000000002';
const OBJ_POLK = 'b141b7a4-0000-0000-0000-0000000000f1';

const OBJECTS = new Map([
  [OBJ_MARK, { id: OBJ_MARK, name: 'ЖК Марк (лот 33)', alt_name: 'Автозаводская ул.', is_active: true }],
  [OBJ_WAVE, { id: OBJ_WAVE, name: 'ЖК Wave', alt_name: null, is_active: false }],
  [OBJ_POLK, { id: OBJ_POLK, name: 'Офис Полковая', alt_name: 'Текущая деятельность', is_active: true }],
]);

const UNKNOWN = { key: 'unknown', name: 'Не определён' };
const SKUD = { mode: 'skud' as const, pinnedObjectId: null, source: 'legacy_default' as const };

const item = (over: Partial<IMonthAttribution>): IMonthAttribution => ({
  object: UNKNOWN,
  departmentId: 'dep-1',
  mode: SKUD,
  ...over,
});

/** 23.10.2026 12:00 МСК. */
const NOW = new Date('2026-10-23T12:00:00+03:00');

beforeEach(() => {
  vi.clearAllMocks();
  timesheetObject.loadSkudObjects.mockResolvedValue(OBJECTS);
  timesheetObject.loadTimesheetObjectHours.mockResolvedValue(new Map());
});

describe('resolveSummaryObjects', () => {
  it('базовый объект есть — не трогается, справочник и часы не запрашиваются', async () => {
    const result = await resolveSummaryObjects(new Map([
      ['1|2026-08', item({ object: { key: OBJ_MARK, name: 'ЖК Марк (лот 33)' } })],
      ['2|2026-08', item({ object: { key: 'office', name: 'Офис' } })],
    ]), NOW);

    expect(result.size).toBe(0);
    expect(timesheetObject.loadSkudObjects).not.toHaveBeenCalled();
    expect(timesheetObject.loadTimesheetObjectHours).not.toHaveBeenCalled();
  });

  it('базовый «Не определён»: режим «Объект» и «Текущая деятельность» главнее часов', async () => {
    const result = await resolveSummaryObjects(new Map([
      ['1|2026-08', item({ mode: { mode: 'object', pinnedObjectId: OBJ_MARK, source: 'employee_explicit' } })],
      ['2|2026-08', item({ mode: { mode: 'current_activity', pinnedObjectId: null, source: 'legacy_department' } })],
    ]), NOW);

    expect(result.get('1|2026-08')).toEqual({ key: OBJ_MARK, name: 'ЖК Марк (лот 33)' });
    expect(result.get('2|2026-08')).toEqual({ key: 'office', name: 'Офис' });
    expect(timesheetObject.loadTimesheetObjectHours).not.toHaveBeenCalled();
  });

  it('«СКУД» / нет режима — объект с наибольшими часами месяца; офисная группа — «Офис»; часов нет — пусто', async () => {
    timesheetObject.loadTimesheetObjectHours.mockResolvedValue(new Map([
      [265, [
        { value: OBJ_MARK, label: 'ЖК Марк (лот 33)', objectId: OBJ_MARK, hours: 101.81 },
        { value: 'office', label: 'Офис', objectId: null, hours: 3 },
      ]],
      [266, [{ value: 'office', label: 'Офис', objectId: null, hours: 128.3 }]],
    ]));

    const result = await resolveSummaryObjects(new Map([
      ['265|2026-08', item({})],
      ['266|2026-08', item({ mode: undefined })],
      ['267|2026-08', item({})],
    ]), NOW);

    expect(result.get('265|2026-08')).toEqual({ key: OBJ_MARK, name: 'ЖК Марк (лот 33)' });
    expect(result.get('266|2026-08')).toEqual({ key: 'office', name: 'Офис' });
    expect(result.has('267|2026-08')).toBe(false);
    expect(timesheetObject.loadTimesheetObjectHours).toHaveBeenCalledTimes(1);
    expect(timesheetObject.loadTimesheetObjectHours).toHaveBeenCalledWith(
      [265, 266, 267],
      { start: '2026-08-01', end: '2026-08-31' },
      { todayStr: '2026-10-23', objectsById: OBJECTS, includeInactive: true },
    );
  });

  it('закреплённый объект не нашёлся в справочнике — дальше часы', async () => {
    timesheetObject.loadTimesheetObjectHours.mockResolvedValue(new Map([
      [5, [{ value: OBJ_WAVE, label: 'ЖК Wave', objectId: OBJ_WAVE, hours: 40 }]],
    ]));

    const result = await resolveSummaryObjects(new Map([
      ['5|2026-07', item({ mode: { mode: 'object', pinnedObjectId: 'нет-такого', source: 'employee_explicit' } })],
    ]), NOW);

    expect(result.get('5|2026-07')).toEqual({ key: OBJ_WAVE, name: 'ЖК Wave' });
  });

  it('месяцы — каждый своим периодом: завершённый целиком, текущий по вчера', async () => {
    await resolveSummaryObjects(new Map([
      ['1|2026-07', item({})],
      ['1|2026-10', item({})],
      ['2|2026-07', item({})],
    ]), NOW);

    const calls = timesheetObject.loadTimesheetObjectHours.mock.calls.map(call => [call[0], call[1]]);
    expect(calls).toEqual([
      [[1, 2], { start: '2026-07-01', end: '2026-07-31' }],
      [[1], { start: '2026-10-01', end: '2026-10-22' }],
    ]);
  });

  it('1-е число текущего месяца — часы не запрашиваются, остаётся «Не определён»', async () => {
    const result = await resolveSummaryObjects(
      new Map([['1|2026-10', item({})]]),
      new Date('2026-10-01T12:00:00+03:00'),
    );

    expect(result.size).toBe(0);
    expect(timesheetObject.loadTimesheetObjectHours).not.toHaveBeenCalled();
  });
});
