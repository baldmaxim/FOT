import { describe, expect, it } from 'vitest';

import {
  countMonthObjects,
  employeesMatchingMonthFilter,
  matchesMonthFilter,
  monthProfileKey,
  type IMonthPair,
  type IMonthProfile,
} from './payroll-month-profile.rules.js';
import { parseMonthFilterQuery, parseObjectsCategory } from '../../controllers/payroll-terms-month-filter.js';

const KHIMKI = { key: '00000000-0000-0000-0000-00000000000a', name: 'Химки' };
const MYTISHCHI = { key: '00000000-0000-0000-0000-00000000000b', name: 'Мытищи' };
const OFFICE = { key: 'office', name: 'Офис' };
const UNKNOWN = { key: 'unknown', name: 'Не определён' };

const profiles = (entries: Array<[number, string, IMonthProfile]>): Map<string, IMonthProfile> => (
  new Map(entries.map(([employeeId, month, profile]) => [monthProfileKey(employeeId, month), profile]))
);

describe('matchesMonthFilter', () => {
  it('без условий — любой профиль', () => {
    expect(matchesMonthFilter({ category: 'worker', object: KHIMKI }, {})).toBe(true);
  });

  it('категория и объект — оба в одной паре', () => {
    const profile: IMonthProfile = { category: 'itr', object: KHIMKI };
    expect(matchesMonthFilter(profile, { category: 'itr', objectKey: KHIMKI.key })).toBe(true);
    expect(matchesMonthFilter(profile, { category: 'worker', objectKey: KHIMKI.key })).toBe(false);
    expect(matchesMonthFilter(profile, { category: 'itr', objectKey: MYTISHCHI.key })).toBe(false);
  });
});

describe('employeesMatchingMonthFilter', () => {
  const pairs: IMonthPair[] = [
    { employeeId: 1, month: '2026-09' },
    { employeeId: 1, month: '2026-10' },
    { employeeId: 2, month: '2026-10' },
  ];
  const byPair = profiles([
    // Рабочий на Химках в сентябре, ИТР в Мытищах в октябре.
    [1, '2026-09', { category: 'worker', object: KHIMKI }],
    [1, '2026-10', { category: 'itr', object: MYTISHCHI }],
    [2, '2026-10', { category: 'itr', object: KHIMKI }],
  ]);

  it('категория и объект совпали только в разных месяцах — не проходит', () => {
    expect(employeesMatchingMonthFilter(pairs, byPair, { category: 'itr', objectKey: KHIMKI.key })).toEqual([2]);
  });

  it('хоть в одном месяце — проходит', () => {
    expect(employeesMatchingMonthFilter(pairs, byPair, { category: 'worker' })).toEqual([1]);
    expect(employeesMatchingMonthFilter(pairs, byPair, { objectKey: KHIMKI.key })).toEqual([1, 2]);
  });

  it('пары без профиля не учитываются', () => {
    expect(employeesMatchingMonthFilter([{ employeeId: 3, month: '2026-10' }], byPair, {})).toEqual([]);
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
    [1, '2026-09', { category: 'worker', object: KHIMKI }],
    [1, '2026-10', { category: 'worker', object: KHIMKI }],
    [2, '2026-09', { category: 'worker', object: KHIMKI }],
    [2, '2026-10', { category: 'itr', object: MYTISHCHI }],
    [3, '2026-10', { category: 'office', object: OFFICE }],
    [4, '2026-10', { category: 'worker', object: UNKNOWN }],
  ]);

  it('count — уникальные сотрудники; «Офис» и «Не определён» в конце', () => {
    expect(countMonthObjects(pairs, byPair)).toEqual([
      { key: MYTISHCHI.key, name: 'Мытищи', count: 1 },
      { key: KHIMKI.key, name: 'Химки', count: 2 },
      { key: 'office', name: 'Офис', count: 1 },
      { key: 'unknown', name: 'Не определён', count: 1 },
    ]);
  });

  it('категория сужает объекты по паре месяца', () => {
    expect(countMonthObjects(pairs, byPair, 'worker')).toEqual([
      { key: KHIMKI.key, name: 'Химки', count: 2 },
      { key: 'unknown', name: 'Не определён', count: 1 },
    ]);
  });
});

describe('parseMonthFilterQuery', () => {
  it('без параметров — фильтра нет при любых месяцах', () => {
    expect(parseMonthFilterQuery({}, null)).toEqual({ ok: true, filter: null });
    expect(parseMonthFilterQuery({}, 'all')).toEqual({ ok: true, filter: null });
  });

  it('со списком месяцев — оба разрешены', () => {
    expect(parseMonthFilterQuery({ category: 'office', object: KHIMKI.key }, ['2026-09'])).toEqual({
      ok: true, filter: { category: 'office', objectKey: KHIMKI.key },
    });
    expect(parseMonthFilterQuery({ object: 'unknown' }, ['2026-09'])).toEqual({ ok: true, filter: { objectKey: 'unknown' } });
  });

  it('без месяцев и «весь период» — отказ', () => {
    expect(parseMonthFilterQuery({ category: 'itr' }, null)).toMatchObject({ ok: false, code: 'MONTH_FILTER_NEEDS_MONTHS' });
    expect(parseMonthFilterQuery({ object: 'office' }, 'all')).toMatchObject({ ok: false, code: 'MONTH_FILTER_NEEDS_MONTHS' });
  });

  it('объект — только office, unknown или UUID; категория — из трёх', () => {
    expect(parseMonthFilterQuery({ object: 'Химки' }, ['2026-09'])).toMatchObject({ ok: false, code: 'INVALID_MONTH_FILTER' });
    expect(parseMonthFilterQuery({ category: 'all' }, ['2026-09'])).toMatchObject({ ok: false, code: 'INVALID_MONTH_FILTER' });
    expect(parseMonthFilterQuery({ category: ['itr', 'worker'] }, ['2026-09'])).toMatchObject({ ok: false });
  });

  it('категория списка объектов', () => {
    expect(parseObjectsCategory(undefined)).toEqual({ ok: true, category: undefined });
    expect(parseObjectsCategory('worker')).toEqual({ ok: true, category: 'worker' });
    expect(parseObjectsCategory('boss')).toEqual({ ok: false });
  });
});
