/**
 * Фильтр «Объект» на «Расчётах»: профиль пары «сотрудник + месяц» (payroll-month-profile.service — объект месяца тем же
 * расчётом, что у «Свода») → кто проходит фильтр и какие объекты предложить. Группы ИТР / Рабочие «Расчётов» —
 * по отделу (payroll-department-groups.ts), не отсюда. Чистые функции: порядок пар на результат не влияет.
 */
import type { ISummaryObject } from './payroll-summary.attribution.js';
import { SUMMARY_OFFICE, SUMMARY_UNKNOWN } from './payroll-summary.attribution.js';

/** Пара «сотрудник + месяц» (YYYY-MM), в которой сотрудник виден в «Расчётах». */
export interface IMonthPair {
  employeeId: number;
  month: string;
}

/** Объект пары — как у строки «Свода». */
export interface IMonthProfile {
  object: ISummaryObject;
}

/** Фильтр «Расчётов» по объекту: id объекта СКУД, 'office' или 'unknown'. */
export interface IMonthFilter {
  objectKey: string;
}

/** Вариант списка «Все объекты»: count — уникальные сотрудники. */
export interface IMonthObjectOption {
  key: string;
  name: string;
  count: number;
}

export const monthProfileKey = (employeeId: number, month: string): string => `${employeeId}|${month}`;

/** Сотрудники, у которых хоть в одном месяце объект — выбранный (по возрастанию id). */
export const employeesMatchingMonthFilter = (
  pairs: readonly IMonthPair[],
  profiles: ReadonlyMap<string, IMonthProfile>,
  filter: IMonthFilter,
): number[] => {
  const ids = new Set<number>();
  for (const pair of pairs) {
    const profile = profiles.get(monthProfileKey(pair.employeeId, pair.month));
    if (profile && profile.object.key === filter.objectKey) ids.add(pair.employeeId);
  }
  return [...ids].sort((left, right) => left - right);
};

/** «Офис» и «Не определён» — в конце списка, остальные по имени. */
const objectRank = (key: string): number => {
  if (key === SUMMARY_OFFICE.key) return 1;
  if (key === SUMMARY_UNKNOWN.key) return 2;
  return 0;
};

/**
 * Объекты пар: count — уникальные сотрудники (один человек за несколько месяцев может войти в счётчики нескольких
 * объектов, но в каждый — один раз).
 */
export const countMonthObjects = (
  pairs: readonly IMonthPair[],
  profiles: ReadonlyMap<string, IMonthProfile>,
): IMonthObjectOption[] => {
  const byKey = new Map<string, { name: string; ids: Set<number> }>();
  for (const pair of pairs) {
    const profile = profiles.get(monthProfileKey(pair.employeeId, pair.month));
    if (!profile) continue;
    const target = byKey.get(profile.object.key);
    if (target) target.ids.add(pair.employeeId);
    else byKey.set(profile.object.key, { name: profile.object.name, ids: new Set([pair.employeeId]) });
  }
  return [...byKey]
    .map(([key, value]) => ({ key, name: value.name, count: value.ids.size }))
    .sort((left, right) => objectRank(left.key) - objectRank(right.key)
      || left.name.localeCompare(right.name, 'ru')
      || left.key.localeCompare(right.key));
};
