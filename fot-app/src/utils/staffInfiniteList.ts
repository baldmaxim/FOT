import type { Employee } from '../types';
import type { IEmployeeListCursor, PaginatedResponse } from '../services/employeeService';

/** Структура данных useInfiniteQuery списка сотрудников. */
export interface IEmployeePagesData {
  pages: PaginatedResponse[];
  pageParams: Array<IEmployeeListCursor | null>;
}

/** Курсор следующей порции; undefined — порций больше нет (контракт getNextPageParam). */
export const getNextEmployeeCursor = (lastPage: PaginatedResponse): IEmployeeListCursor | undefined =>
  lastPage.meta.next_cursor ?? undefined;

/**
 * Склейка порций с дедупом по id (первое вхождение). Курсор не даёт сдвига при вставках и
 * увольнениях, но переименование через границу порций может повторить строку — её убираем.
 */
export const mergeEmployeePages = (pages: readonly PaginatedResponse[]): Employee[] => {
  const seen = new Set<number>();
  const result: Employee[] = [];
  for (const page of pages) {
    for (const employee of page.data) {
      if (seen.has(employee.id)) continue;
      seen.add(employee.id);
      result.push(employee);
    }
  }
  return result;
};

/** id по порциям после дедупа — для догрузки графиков и объектов по одному запросу на порцию. */
export const buildPageIdChunks = (pages: readonly PaginatedResponse[]): number[][] => {
  const seen = new Set<number>();
  const chunks: number[][] = [];
  for (const page of pages) {
    const ids: number[] = [];
    for (const employee of page.data) {
      if (seen.has(employee.id)) continue;
      seen.add(employee.id);
      ids.push(employee.id);
    }
    if (ids.length > 0) chunks.push(ids);
  }
  return chunks;
};

/** Точечная правка сотрудника во всех порциях без перезапроса списка. */
export const patchEmployeeInPages = (
  data: IEmployeePagesData | undefined,
  id: number,
  patch: Partial<Employee>,
): IEmployeePagesData | undefined => {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      data: page.data.map(employee => (employee.id === id ? { ...employee, ...patch } : employee)),
    })),
  };
};

/** Результат одного запроса-порции (минимум полей useQueries, нужный для склейки). */
export interface IChunkQueryState<T> {
  ids: readonly number[];
  data: T | undefined;
  isSuccess: boolean;
  isError: boolean;
  /** Показ старых данных под новым ключом недопустим: значения относились бы к другим людям. */
  isPlaceholderData: boolean;
}

export interface IChunkReadiness {
  /** Порция успешно загружена: отсутствие значения — это «—», а не «ещё грузится». */
  readyIds: ReadonlySet<number>;
  /** Порция упала: ячейке нужен признак ошибки, а не вечный скелетон. */
  errorIds: ReadonlySet<number>;
}

/** Готовность по id: успешные порции → readyIds, упавшие → errorIds, прочие — загружаются. */
export const collectChunkReadiness = <T>(chunks: ReadonlyArray<IChunkQueryState<T>>): IChunkReadiness => {
  const readyIds = new Set<number>();
  const errorIds = new Set<number>();
  for (const chunk of chunks) {
    if (chunk.isSuccess && !chunk.isPlaceholderData && chunk.data !== undefined) {
      for (const id of chunk.ids) readyIds.add(id);
    } else if (chunk.isError) {
      for (const id of chunk.ids) errorIds.add(id);
    }
  }
  return { readyIds, errorIds };
};

export type ChunkCellState = 'loading' | 'ready' | 'error';

export const chunkCellState = (id: number, readiness: IChunkReadiness): ChunkCellState => {
  if (readiness.readyIds.has(id)) return 'ready';
  if (readiness.errorIds.has(id)) return 'error';
  return 'loading';
};

/** Ключ запроса порции содержит её id (последний элемент ключа) — пересекается ли он с изменёнными. */
export const chunkKeyTouchesEmployees = (queryKey: readonly unknown[], employeeIds: ReadonlySet<number>): boolean => {
  const ids = queryKey[queryKey.length - 1];
  return Array.isArray(ids) && ids.some(id => typeof id === 'number' && employeeIds.has(id));
};
