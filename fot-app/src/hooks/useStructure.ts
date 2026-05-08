import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { structureApi } from '../api/structure';
import type { OrgStructureResponse } from '../types';
import { sortDepartmentTree } from '../utils/departmentUtils';

export const STRUCTURE_QUERY_KEY = ['structure', 'tree'] as const;

export const useStructureTree = (enabled = true) => {
  return useQuery({
    queryKey: STRUCTURE_QUERY_KEY,
    queryFn: async () => {
      const t0 = performance.now();
      try {
        const res = await structureApi.getTree();
        if (res.error) throw new Error(res.error);
        const data = res.data as OrgStructureResponse;
        const dt = performance.now() - t0;
        if (dt > 3000) {
          Sentry.captureMessage('structure-tree slow fetch', {
            level: 'warning',
            tags: { query: 'structure-tree', durationMs: String(Math.round(dt)) },
          });
        }
        return {
          ...data,
          departments: sortDepartmentTree(data.departments || []),
        };
      } catch (e) {
        Sentry.captureException(e, { tags: { query: 'structure-tree' } });
        throw e;
      }
    },
    enabled,
    staleTime: 15 * 60_000,
    // gcTime > staleTime обязательно: иначе кеш выбрасывается из памяти раньше, чем считается stale,
    // и при возврате на страницу селектор пуст до завершения refetch (root-cause бага «пропадают отделы»).
    gcTime: 24 * 60 * 60_000,
    refetchOnMount: 'always',
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    // Игнорируем previousData с пустым departments: если бэк хоть раз отдал 200 OK
    // с empty (например, scope-fallback при rpc_timeout вернул []), placeholderData
    // залипает на empty и UI не показывает loading — селектор остаётся пустым до
    // явного invalidate. Лучше показать пустое состояние/loading, чем зафиксировать
    // плохое значение как "хорошее".
    placeholderData: (previousData) => (
      previousData && previousData.departments && previousData.departments.length > 0
        ? previousData
        : undefined
    ),
  });
};

/** Хук для инвалидации кэша структуры (после CRUD операций) */
export const useInvalidateStructure = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: STRUCTURE_QUERY_KEY });
};
