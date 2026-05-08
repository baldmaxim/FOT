import { useQuery, useQueryClient } from '@tanstack/react-query';
import { structureApi } from '../api/structure';
import type { OrgStructureResponse } from '../types';
import { sortDepartmentTree } from '../utils/departmentUtils';

export const STRUCTURE_QUERY_KEY = ['structure', 'tree'] as const;

export const useStructureTree = (enabled = true) => {
  return useQuery({
    queryKey: STRUCTURE_QUERY_KEY,
    queryFn: async () => {
      const res = await structureApi.getTree();
      if (res.error) throw new Error(res.error);
      const data = res.data as OrgStructureResponse;
      return {
        ...data,
        departments: sortDepartmentTree(data.departments || []),
      };
    },
    enabled,
    staleTime: 15 * 60_000,
  });
};

/** Хук для инвалидации кэша структуры (после CRUD операций) */
export const useInvalidateStructure = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: STRUCTURE_QUERY_KEY });
};
