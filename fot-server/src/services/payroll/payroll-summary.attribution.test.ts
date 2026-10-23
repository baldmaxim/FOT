import { describe, expect, it } from 'vitest';

import {
  centsToAmount,
  fallbackSummaryObject,
  pickMainObject,
  pickMonthDepartment,
  summaryHoursPeriod,
  summaryObjectFromHours,
  summaryObjectOf,
  toCents,
  type ISummaryBreakdownRow,
} from './payroll-summary.attribution.js';

const OBJ_A = '00000000-0000-0000-0000-00000000000a';
const OBJ_B = '00000000-0000-0000-0000-00000000000b';
const OFFICE_POLKOVAYA = '00000000-0000-0000-0000-0000000000f1';

const row = (over: Partial<ISummaryBreakdownRow>): ISummaryBreakdownRow => ({
  version_id: 1,
  department_id: 'dep-1',
  object_key: OBJ_A,
  object_id: OBJ_A,
  object_name: 'ЖК Химки',
  object_address: 'Химки, ул. Ленина, 1',
  hours: 8,
  ...over,
});

describe('summaryObjectOf', () => {
  it('«Текущая деятельность» — псевдо-объект и объект с таким адресом — это «Офис»', () => {
    expect(summaryObjectOf(row({ object_key: '__current_activity__', object_id: null }))).toEqual({ key: 'office', name: 'Офис' });
    expect(summaryObjectOf(row({ object_key: OFFICE_POLKOVAYA, object_id: OFFICE_POLKOVAYA, object_address: ' Текущая деятельность ' })))
      .toEqual({ key: 'office', name: 'Офис' });
  });

  it('нераспознанный объект — «Не определён»; реальный — сам объект', () => {
    expect(summaryObjectOf(row({ object_key: '__unknown_object__', object_id: null }))).toEqual({ key: 'unknown', name: 'Не определён' });
    expect(summaryObjectOf(row({}))).toEqual({ key: OBJ_A, name: 'ЖК Химки' });
  });
});

describe('pickMainObject', () => {
  it('часы двух подач месяца складываются; «СКУД» — объект с наибольшими часами', () => {
    expect(pickMainObject([
      row({ version_id: 1, hours: 60 }),
      row({ version_id: 1, object_key: OBJ_B, object_id: OBJ_B, object_name: 'ЖК Мытищи', hours: 80 }),
      row({ version_id: 2, hours: 30 }),
    ])).toEqual({ key: OBJ_A, name: 'ЖК Химки' });
  });

  it('ничья — по имени, затем по ключу; от порядка строк не зависит', () => {
    const rows = [
      row({ object_key: OBJ_B, object_id: OBJ_B, object_name: 'ЖК Мытищи', hours: 40 }),
      row({ hours: 40 }),
    ];
    // «ЖК Мытищи» < «ЖК Химки».
    expect(pickMainObject(rows)).toEqual({ key: OBJ_B, name: 'ЖК Мытищи' });
    expect(pickMainObject([...rows].reverse())).toEqual({ key: OBJ_B, name: 'ЖК Мытищи' });
    const sameName = [
      row({ object_key: OBJ_B, object_id: OBJ_B, hours: 40 }),
      row({ hours: 40 }),
    ];
    expect(pickMainObject(sameName)?.key).toBe(OBJ_A);
    expect(pickMainObject([...sameName].reverse())?.key).toBe(OBJ_A);
  });

  it('несколько офисных объектов — одна группа «Офис»', () => {
    expect(pickMainObject([
      row({ object_key: '__current_activity__', object_id: null, hours: 30 }),
      row({ object_key: OFFICE_POLKOVAYA, object_id: OFFICE_POLKOVAYA, object_address: 'Текущая деятельность', hours: 30 }),
      row({ hours: 50 }),
    ])).toEqual({ key: 'office', name: 'Офис' });
  });

  it('часов нет (пустая разбивка, нули) — null: нужен запасной путь', () => {
    expect(pickMainObject([])).toBeNull();
    expect(pickMainObject([row({ hours: 0 }), row({ object_key: null, object_id: null, hours: 0 })])).toBeNull();
  });
});

describe('pickMonthDepartment', () => {
  it('отдел подачи с наибольшими часами; ничья — более поздняя подача', () => {
    expect(pickMonthDepartment([
      row({ version_id: 1, department_id: 'dep-1', hours: 40 }),
      row({ version_id: 2, department_id: 'dep-2', hours: 60 }),
    ])).toBe('dep-2');
    expect(pickMonthDepartment([
      row({ version_id: 7, department_id: 'dep-7', hours: 40 }),
      row({ version_id: 3, department_id: 'dep-3', hours: 40 }),
    ])).toBe('dep-7');
  });

  it('персональная подача (без отдела) или подачи нет — null', () => {
    expect(pickMonthDepartment([row({ department_id: null })])).toBeNull();
    expect(pickMonthDepartment([])).toBeNull();
  });
});

describe('fallbackSummaryObject', () => {
  const meta = new Map([
    [OBJ_A, { name: 'ЖК Химки', address: 'Химки' }],
    [OFFICE_POLKOVAYA, { name: 'Офис Полковая', address: 'Текущая деятельность' }],
  ]);

  it('закреплённый объект; офисный — «Офис»; объекта нет в справочнике — «Не определён»', () => {
    expect(fallbackSummaryObject({ mode: 'object', pinnedObjectId: OBJ_A, source: 'employee_explicit' }, meta))
      .toEqual({ key: OBJ_A, name: 'ЖК Химки' });
    expect(fallbackSummaryObject({ mode: 'object', pinnedObjectId: OFFICE_POLKOVAYA, source: 'employee_explicit' }, meta))
      .toEqual({ key: 'office', name: 'Офис' });
    expect(fallbackSummaryObject({ mode: 'object', pinnedObjectId: OBJ_B, source: 'employee_explicit' }, meta))
      .toEqual({ key: 'unknown', name: 'Не определён' });
  });

  it('«Текущая деятельность» — «Офис»; «СКУД» и неизвестный режим — «Не определён»', () => {
    expect(fallbackSummaryObject({ mode: 'current_activity', pinnedObjectId: null, source: 'legacy_department' }, meta))
      .toEqual({ key: 'office', name: 'Офис' });
    expect(fallbackSummaryObject({ mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }, meta).key).toBe('unknown');
    expect(fallbackSummaryObject(undefined, meta).key).toBe('unknown');
  });
});

describe('summaryHoursPeriod — часы месяца для объекта «Свода»', () => {
  it('завершённый месяц — целиком, февраль и високосный год — по календарю', () => {
    expect(summaryHoursPeriod('2026-08-01', '2026-10-23')).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(summaryHoursPeriod('2026-02-01', '2026-10-23')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(summaryHoursPeriod('2028-02-01', '2028-03-05')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('текущий месяц — по вчера, как ночной расчёт; последнее число месяца — тоже по вчера', () => {
    expect(summaryHoursPeriod('2026-10-01', '2026-10-23')).toEqual({ start: '2026-10-01', end: '2026-10-22' });
    expect(summaryHoursPeriod('2026-10-01', '2026-10-31')).toEqual({ start: '2026-10-01', end: '2026-10-30' });
  });

  it('1-е число текущего месяца и будущий месяц — часов нет', () => {
    expect(summaryHoursPeriod('2026-10-01', '2026-10-01')).toBeNull();
    expect(summaryHoursPeriod('2026-11-01', '2026-10-23')).toBeNull();
  });
});

describe('summaryObjectFromHours', () => {
  it('объект — с id и именем; офисная группа — «Офис»; часов нет — null', () => {
    expect(summaryObjectFromHours({ objectId: OBJ_A, label: 'ЖК Марк (лот 33)' })).toEqual({ key: OBJ_A, name: 'ЖК Марк (лот 33)' });
    expect(summaryObjectFromHours({ objectId: null, label: 'Офис' })).toEqual({ key: 'office', name: 'Офис' });
    expect(summaryObjectFromHours(undefined)).toBeNull();
  });
});

describe('копейки', () => {
  it('сумма без потерь на дробях, отрицательная — со знаком', () => {
    expect(toCents('0.10') + toCents('0.20')).toBe(30);
    expect(centsToAmount(toCents('175000.50') + toCents('-1250.25'))).toBe('173750.25');
    expect(centsToAmount(-150)).toBe('-1.50');
    expect(centsToAmount(0)).toBe('0.00');
  });
});
