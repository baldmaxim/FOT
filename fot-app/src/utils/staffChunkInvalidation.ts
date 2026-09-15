import type { QueryClient } from '@tanstack/react-query';
import { chunkKeyTouchesEmployees } from './staffInfiniteList';

/**
 * Перечитать только порции, где есть изменённые сотрудники: после правки одного человека
 * при 10 тыс. загруженных строк это один POST, а не по запросу на каждую порцию.
 * Промис — чтобы окно закрывалось уже с обновлёнными данными.
 */
export const refreshStaffChunksFor = (
  queryClient: QueryClient,
  keyPrefix: readonly unknown[],
  employeeIds: readonly number[],
): Promise<void> => {
  const ids = new Set(employeeIds);
  if (ids.size === 0) return Promise.resolve();
  return queryClient.invalidateQueries({
    predicate: query => {
      const key = query.queryKey;
      if (key.length <= keyPrefix.length) return false;
      if (!keyPrefix.every((part, index) => key[index] === part)) return false;
      return chunkKeyTouchesEmployees(key, ids);
    },
  });
};
