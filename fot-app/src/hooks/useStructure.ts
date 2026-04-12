import { useQuery, useQueryClient } from '@tanstack/react-query';
import { structureApi } from '../api/structure';
import type { OrgStructureResponse } from '../types';

export const STRUCTURE_QUERY_KEY = ['structure', 'tree'] as const;

export const useStructureTree = (enabled = true) => {
  return useQuery({
    queryKey: STRUCTURE_QUERY_KEY,
    queryFn: async () => {
      const res = await structureApi.getTree();
      if (res.error) throw new Error(res.error);
      return res.data as OrgStructureResponse;
    },
    enabled,
    staleTime: 5 * 60_000,
  });
};

/** Хук для инвалидации кэша структуры (после CRUD операций) */
export const useInvalidateStructure = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: STRUCTURE_QUERY_KEY });
};
