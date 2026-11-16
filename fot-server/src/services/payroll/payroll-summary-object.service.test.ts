import { beforeEach, describe, expect, it, vi } from 'vitest';

// «Свод»: объект строки при базовом «Не определён» — режим месяца, часы месяца (правило ночного объекта
// табелирования), прежний объект (закрытые табели, затем проходы прошлых месяцев), объект бригады или отдела
// месяца, текущий объект табелирования; иначе «Не определён». Базовый объект не трогается.
vi.mock('../../config/postgres.js', () => ({ query: vi.fn() }));

const timesheetObject = vi.hoisted(() => ({
  loadSkudObjects: vi.fn(),
  loadTimesheetObjectHours: vi.fn(),
}));
vi.mock('../employee-timesheet-object.service.js', () => timesheetObject);

const exportMode = vi.hoisted(() => ({ resolveExportModes: vi.fn() }));
vi.mock('../timesheet-export-mode.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../timesheet-export-mode.service.js')>()),
  ...exportMode,
}));

const monthAttribution = vi.hoisted(() => ({
  loadMonthBreakdown: vi.fn(),
  loadDepartmentMonthBreakdown: vi.fn(),
}));
vi.mock('./payroll-month-attribution.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./payroll-month-attribution.service.js')>()),
  ...monthAttribution,
}));

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
  exportMode.resolveExportModes.mockResolvedValue(new Map());
  monthAttribution.loadMonthBreakdown.mockResolvedValue(new Map());
  monthAttribution.loadDepartmentMonthBreakdown.mockResolvedValue(new Map());
});

/** Строка разбивки закрытого табеля: часы на объекте. */
const row = (objectId: string | null, hours: number, name = 'имя на закрытии') => ({
  version_id: 1,
  department_id: 'dep-1',
  object_key: objectId ?? '__unknown_object__',
  object_id: objectId,
  object_name: objectId ? name : 'Не определён',
  object_address: null,
  hours,
});

/** Периоды вызовов часов (без сотрудников). */
const hourPeriods = (): unknown[] => timesheetObject.loadTimesheetObjectHours.mock.calls.map(call => call[1]);

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
    expect(timesheetObject.loadTimesheetObjectHours).toHaveBeenNthCalledWith(
      1,
      [265, 266, 267],
      { start: '2026-08-01', end: '2026-08-31' },
      { todayStr: '2026-10-23', objectsById: OBJECTS, includeInactive: true },
    );
    // Дальше ищется только 267 — у остальных объект нашёлся по часам месяца.
    expect(timesheetObject.loadTimesheetObjectHours.mock.calls.slice(1).every(call => String(call[0]) === '267')).toBe(true);
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
    // Сначала часы самих месяцев, затем прошлые месяцы (прежний объект).
    expect(calls.slice(0, 2)).toEqual([
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
    expect(hourPeriods()).not.toContainEqual(expect.objectContaining({ start: '2026-10-01' }));
    expect(hourPeriods()[0]).toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });

  it('прежний объект: ближайший прошлый месяц закрытого табеля с часами на объекте, «Не определён» не спорит', async () => {
    monthAttribution.loadMonthBreakdown.mockResolvedValue(new Map([
      // Август: одни неявки без объекта (больше часов) и немного работы на Wave — объект Wave.
      ['1|2026-08', [row(null, 220), row(OBJ_WAVE, 11, 'Wave старое имя')]],
      ['1|2026-07', [row(OBJ_MARK, 160)]],
      // У второго август пуст — берётся июль.
      ['2|2026-07', [row(OBJ_MARK, 100)]],
      // Третьему — только «Не определён»: прежнего нет.
      ['3|2026-08', [row(null, 50)]],
    ]));

    const stats = {
      unknown: 0, byMode: 0, hoursEmployees: 0, hoursMs: 0,
      byPrevTimesheet: 0, byPrevHours: 0, byDepartment: 0, byCurrentObject: 0,
    };
    const result = await resolveSummaryObjects(new Map([
      ['1|2026-09', item({})],
      ['2|2026-09', item({})],
      ['3|2026-09', item({})],
    ]), NOW, stats);

    expect(result.get('1|2026-09')).toEqual({ key: OBJ_WAVE, name: 'ЖК Wave' });
    expect(result.get('2|2026-09')).toEqual({ key: OBJ_MARK, name: 'ЖК Марк (лот 33)' });
    expect(result.has('3|2026-09')).toBe(false);
    expect(monthAttribution.loadMonthBreakdown).toHaveBeenCalledTimes(1);
    expect(monthAttribution.loadMonthBreakdown).toHaveBeenCalledWith(
      ['2026-08-01', '2026-07-01', '2026-06-01', '2026-05-01', '2026-04-01', '2026-03-01'],
      [1, 2, 3],
    );
    expect(stats).toMatchObject({ unknown: 3, byPrevTimesheet: 2 });
  });

  it('прежний объект по проходам: месяц за месяцем назад, только кому табель не дал', async () => {
    monthAttribution.loadMonthBreakdown.mockResolvedValue(new Map([['1|2026-07', [row(OBJ_MARK, 160)]]]));
    timesheetObject.loadTimesheetObjectHours.mockImplementation(async (ids: number[], period: { start: string }) => {
      if (period.start === '2026-08-01') return new Map([[2, []]]);
      if (period.start === '2026-07-01') return new Map([[2, [{ value: 'office', label: 'Офис', objectId: null, hours: 40 }]]]);
      return new Map();
    });

    const result = await resolveSummaryObjects(new Map([
      ['1|2026-09', item({})],
      ['2|2026-09', item({})],
    ]), NOW);

    expect(result.get('1|2026-09')).toEqual({ key: OBJ_MARK, name: 'ЖК Марк (лот 33)' });
    expect(result.get('2|2026-09')).toEqual({ key: 'office', name: 'Офис' });
    expect(timesheetObject.loadTimesheetObjectHours.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [[1, 2], { start: '2026-09-01', end: '2026-09-30' }],
      [[2], { start: '2026-08-01', end: '2026-08-31' }],
      [[2], { start: '2026-07-01', end: '2026-07-31' }],
    ]);
  });

  it('объект бригады месяца — кому прежнего нет; затем текущий объект табелирования; иначе «Не определён»', async () => {
    monthAttribution.loadDepartmentMonthBreakdown.mockResolvedValue(new Map([
      ['brig-1|2026-09', [row(null, 900), row(OBJ_MARK, 500), row(OBJ_WAVE, 300)]],
    ]));
    exportMode.resolveExportModes.mockResolvedValue(new Map([
      [2, { mode: 'object', pinnedObjectId: OBJ_WAVE, source: 'employee_explicit' }],
      [3, { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }],
    ]));

    const result = await resolveSummaryObjects(new Map([
      ['1|2026-09', item({ departmentId: 'brig-1' })],
      ['2|2026-09', item({ departmentId: 'dep-empty' })],
      ['3|2026-09', item({ departmentId: null })],
    ]), NOW);

    expect(result.get('1|2026-09')).toEqual({ key: OBJ_MARK, name: 'ЖК Марк (лот 33)' });
    expect(result.get('2|2026-09')).toEqual({ key: OBJ_WAVE, name: 'ЖК Wave' });
    expect(result.has('3|2026-09')).toBe(false);
    expect(monthAttribution.loadDepartmentMonthBreakdown).toHaveBeenCalledWith(['2026-09-01'], ['brig-1', 'dep-empty']);
    expect(exportMode.resolveExportModes).toHaveBeenCalledWith([2, 3]);
  });

  it('прежний объект главнее объекта бригады: запасные шаги не спрашиваются, когда всё нашлось', async () => {
    monthAttribution.loadMonthBreakdown.mockResolvedValue(new Map([['1|2026-08', [row(OBJ_WAVE, 80)]]]));

    const result = await resolveSummaryObjects(new Map([['1|2026-09', item({ departmentId: 'brig-1' })]]), NOW);

    expect(result.get('1|2026-09')).toEqual({ key: OBJ_WAVE, name: 'ЖК Wave' });
    expect(monthAttribution.loadDepartmentMonthBreakdown).not.toHaveBeenCalled();
    expect(exportMode.resolveExportModes).not.toHaveBeenCalled();
  });
});
