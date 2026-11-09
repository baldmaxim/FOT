/**
 * Фильтры «Категория» и «Объект» на «Расчётах»: профиль пары «сотрудник + месяц» (payroll-month-profile.service —
 * категория и объект месяца тем же расчётом, что у «Свода») → кто проходит фильтр и какие объекты предложить.
 * Чистые функции: порядок пар на результат не влияет.
 */
import type { ISummaryObject } from './payroll-summary.attribution.js';
import { SUMMARY_OFFICE, SUMMARY_UNKNOWN } from './payroll-summary.attribution.js';
import type { StaffCategory } from './payroll-terms.service.js';

/** Пара «сотрудник + месяц» (YYYY-MM), в которой сотрудник виден в «Расчётах». */
export interface IMonthPair {
  employeeId: number;
  month: string;
}

/** Категория и объект пары — как у строки «Свода». */
export interface IMonthProfile {
  category: StaffCategory;
  object: ISummaryObject;
}

/** Фильтр «Расчётов»; поля нет — по нему не отбираем. */
export interface IMonthFilter {
  category?: StaffCategory;
  /** id объекта СКУД, 'office' или 'unknown'. */
  objectKey?: string;
}

/** Вариант списка «Все объекты»: count — уникальные сотрудники. */
export interface IMonthObjectOption {
  key: string;
  name: string;
  count: number;
}

export const monthProfileKey = (employeeId: number, month: string): string => `${employeeId}|${month}`;

/** Оба условия — в одной паре: рабочий на X в сентябре и ИТР на Y в октябре фильтр «ИТР + X» не проходит. */
export const matchesMonthFilter = (profile: IMonthProfile, filter: IMonthFilter): boolean => (
  (filter.category === undefined || profile.category === filter.category)
  && (filter.objectKey === undefined || profile.object.key === filter.objectKey)
);

/** Сотрудники, у которых хоть одна пара проходит фильтр (по возрастанию id). */
export const employeesMatchingMonthFilter = (
  pairs: readonly IMonthPair[],
  profiles: ReadonlyMap<string, IMonthProfile>,
  filter: IMonthFilter,
): number[] => {
  const ids = new Set<number>();
  for (const pair of pairs) {
    const profile = profiles.get(monthProfileKey(pair.employeeId, pair.month));
    if (profile && matchesMonthFilter(profile, filter)) ids.add(pair.employeeId);
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
 * Объекты пар выбранной категории: count — уникальные сотрудники (один человек за несколько месяцев может войти
 * в счётчики нескольких объектов, но в каждый — один раз).
 */
export const countMonthObjects = (
  pairs: readonly IMonthPair[],
  profiles: ReadonlyMap<string, IMonthProfile>,
  category?: StaffCategory,
): IMonthObjectOption[] => {
  const byKey = new Map<string, { name: string; ids: Set<number> }>();
  for (const pair of pairs) {
    const profile = profiles.get(monthProfileKey(pair.employeeId, pair.month));
    if (!profile || (category !== undefined && profile.category !== category)) continue;
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
