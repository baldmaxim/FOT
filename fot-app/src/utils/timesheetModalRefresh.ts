import type { TimesheetEntry, TimesheetObjectEntry } from '../types';

// Окно дня табеля показывает проходы свежим запросом, а часы и корректировки — из сетки,
// загруженной раньше. Если сетке больше этого возраста, при открытии окна она
// перечитывается (только по клику, без таймеров), и до обновления править нельзя.
export const MODAL_DATA_MAX_AGE_MS = 60_000;

export interface IModalSourceQueryState {
  // 0 — данных ещё нет (запрос не выполнялся или выключен).
  dataUpdatedAt: number;
  isFetching: boolean;
}

// refetch — данные устарели, перечитать; await — данные свежие, но запрос уже идёт,
// дождаться его; ready — окно можно показывать сразу.
export type ModalRefreshDecision = 'refetch' | 'await' | 'ready';

export const decideModalRefresh = (
  queries: readonly IModalSourceQueryState[],
  now: number,
  maxAgeMs: number = MODAL_DATA_MAX_AGE_MS,
): ModalRefreshDecision => {
  // Запрос без данных (dataUpdatedAt = 0) устаревшим не считается: иначе выключенный
  // запрос недоступного периода заставлял бы перечитывать всё на каждом клике.
  if (queries.some(query => query.dataUpdatedAt > 0 && now - query.dataUpdatedAt > maxAgeMs)) {
    return 'refetch';
  }
  return queries.some(query => query.isFetching) ? 'await' : 'ready';
};

export interface IModalDayData {
  entry: TimesheetEntry | null;
  objects: TimesheetObjectEntry[];
}

// Запись дня и объектные строки одного сотрудника за одну дату. Как в entryMap сетки:
// при повторе ключа сотрудник+дата побеждает последняя запись.
export const pickModalDayData = (
  entries: readonly TimesheetEntry[],
  objects: readonly TimesheetObjectEntry[],
  employeeId: number,
  workDate: string,
): IModalDayData => {
  let entry: TimesheetEntry | null = null;
  for (const item of entries) {
    if (item.employee_id === employeeId && item.work_date === workDate) entry = item;
  }
  return {
    entry,
    objects: objects.filter(item => item.employee_id === employeeId && item.work_date === workDate),
  };
};
