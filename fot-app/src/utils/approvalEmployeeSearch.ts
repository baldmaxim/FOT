import { createFioMatcher, withFioFallback } from './fioSearch';

/** Нормализация ФИО и запроса: регистр и «ё/е» не важны, пробелы схлопнуты. */
export const normalizeFio = (value: string): string =>
  value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/**
 * Совпавшие по ФИО сотрудники каждой подачи табеля: id подачи → совпавшие (подстрока в любом месте ФИО, ё = е,
 * английская раскладка). Точных нет ни в одной подаче набора — с одной ошибкой. Набор — уже после фильтра
 * отдела: точный в чужом отделе опечатку не глушит. Пустой запрос — пустая карта: поиск выключен.
 */
export const matchApprovalEmployees = <E extends { full_name: string }>(
  approvals: ReadonlyArray<{ id: number; employees?: readonly E[] }>,
  query: string,
): Map<number, E[]> => {
  const matcher = createFioMatcher(query);
  if (!matcher) return new Map();
  const entries = withFioFallback(matcher, mode => approvals.flatMap(approval => {
    const matches = (approval.employees ?? []).filter(employee => matcher.matches(employee.full_name, mode));
    return matches.length > 0 ? [[approval.id, matches] as [number, E[]]] : [];
  }));
  return new Map(entries);
};
