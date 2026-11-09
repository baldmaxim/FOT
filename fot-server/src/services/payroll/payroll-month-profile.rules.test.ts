import { describe, expect, it } from 'vitest';

import {
  countMonthObjects,
  employeesMatchingMonthFilter,
  monthProfileKey,
  type IMonthPair,
  type IMonthProfile,
} from './payroll-month-profile.rules.js';
import { parseDepartmentGroupQuery, parseMonthFilterQuery } from '../../controllers/payroll-terms-month-filter.js';

const KHIMKI = { key: '00000000-0000-0000-0000-00000000000a', name: 'Химки' };
const MYTISHCHI = { key: '00000000-0000-0000-0000-00000000000b', name: 'Мытищи' };
const OFFICE = { key: 'office', name: 'Офис' };
const UNKNOWN = { key: 'unknown', name: 'Не определён' };

const profiles = (entries: Array<[number, string, IMonthProfile['object']]>): Map<string, IMonthProfile> => (
  new Map(entries.map(([employeeId, month, object]) => [monthProfileKey(employeeId, month), { object }]))
);

describe('employeesMatchingMonthFilter', () => {
  const pairs: IMonthPair[] = [
    { employeeId: 1, month: '2026-09' },
    { employeeId: 1, month: '2026-10' },
    { employeeId: 2, month: '2026-10' },
  ];
  const byPair = profiles([
    [1, '2026-09', KHIMKI],
    [1, '2026-10', MYTISHCHI],
    [2, '2026-10', KHIMKI],
  ]);

  it('объект хоть в одном месяце — проходит', () => {
    expect(employeesMatchingMonthFilter(pairs, byPair, { objectKey: KHIMKI.key })).toEqual([1, 2]);
    expect(employeesMatchingMonthFilter(pairs, byPair, { objectKey: MYTISHCHI.key })).toEqual([1]);
    expect(employeesMatchingMonthFilter(pairs, byPair, { objectKey: 'office' })).toEqual([]);
  });

  it('пары без профиля не учитываются', () => {
    expect(employeesMatchingMonthFilter([{ employeeId: 3, month: '2026-10' }], byPair, { objectKey: KHIMKI.key })).toEqual([]);
  });
});

describe('countMonthObjects', () => {
  const pairs: IMonthPair[] = [
    { employeeId: 1, month: '2026-09' },
    { employeeId: 1, month: '2026-10' },
    { employeeId: 2, month: '2026-09' },
    { employeeId: 2, month: '2026-10' },
    { employeeId: 3, month: '2026-10' },
    { employeeId: 4, month: '2026-10' },
  ];
  const byPair = profiles([
    [1, '2026-09', KHIMKI],
    [1, '2026-10', KHIMKI],
    [2, '2026-09', KHIMKI],
    [2, '2026-10', MYTISHCHI],
    [3, '2026-10', OFFICE],
    [4, '2026-10', UNKNOWN],
  ]);

  it('count — уникальные сотрудники; «Офис» и «Не определён» в конце', () => {
    expect(countMonthObjects(pairs, byPair)).toEqual([
      { key: MYTISHCHI.key, name: 'Мытищи', count: 1 },
      { key: KHIMKI.key, name: 'Химки', count: 2 },
      { key: 'office', name: 'Офис', count: 1 },
      { key: 'unknown', name: 'Не определён', count: 1 },
    ]);
  });
});

describe('parseDepartmentGroupQuery', () => {
  it('группа — ИТР или Рабочие; не задана — null; от месяцев не зависит', () => {
    expect(parseDepartmentGroupQuery(undefined)).toEqual({ ok: true, group: null });
    expect(parseDepartmentGroupQuery('itr')).toEqual({ ok: true, group: 'itr' });
    expect(parseDepartmentGroupQuery('office')).toMatchObject({ ok: false, code: 'INVALID_DEPARTMENT_GROUP' });
    expect(parseDepartmentGroupQuery('worker')).toEqual({ ok: true, group: 'worker' });
    expect(parseDepartmentGroupQuery('boss')).toMatchObject({ ok: false, code: 'INVALID_DEPARTMENT_GROUP' });
    expect(parseDepartmentGroupQuery(['itr', 'worker'])).toMatchObject({ ok: false });
  });
});

describe('parseMonthFilterQuery', () => {
  it('без объекта — фильтра нет при любых месяцах', () => {
    expect(parseMonthFilterQuery({}, null)).toEqual({ ok: true, filter: null });
    expect(parseMonthFilterQuery({ group: 'itr' }, 'all')).toEqual({ ok: true, filter: null });
  });

  it('со списком месяцев — office, unknown или UUID', () => {
    expect(parseMonthFilterQuery({ object: KHIMKI.key }, ['2026-09'])).toEqual({ ok: true, filter: { objectKey: KHIMKI.key } });
    expect(parseMonthFilterQuery({ object: 'unknown' }, ['2026-09'])).toEqual({ ok: true, filter: { objectKey: 'unknown' } });
    expect(parseMonthFilterQuery({ object: 'Химки' }, ['2026-09'])).toMatchObject({ ok: false, code: 'INVALID_MONTH_FILTER' });
  });

  it('без месяцев и «весь период» — отказ', () => {
    expect(parseMonthFilterQuery({ object: 'office' }, null)).toMatchObject({ ok: false, code: 'MONTH_FILTER_NEEDS_MONTHS' });
    expect(parseMonthFilterQuery({ object: 'office' }, 'all')).toMatchObject({ ok: false, code: 'MONTH_FILTER_NEEDS_MONTHS' });
  });
});
