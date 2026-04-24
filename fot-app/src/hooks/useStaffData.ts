import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Employee } from '../types';
import type { PaginatedMeta } from '../services/employeeService';
import { useStructureTree } from './useStructure';
import {
  EMPTY_EMPLOYEE_COUNTS,
  EMPTY_PAGINATED_META,
  EMPTY_PAGINATED_RESPONSE,
  employeeCountsQueryKey,
  paginatedEmployeesQueryKey,
  useEmployeeCountsQuery,
  usePaginatedEmployeesQuery,
} from './useEmployeeDirectory';

interface IUseStaffDataParams {
  page: number;
  pageSize?: number;
  search?: string;
  departmentId?: string;
  status?: 'active' | 'fired' | 'excluded';
}

export const useStaffData = (params: IUseStaffDataParams) => {
  const { page, pageSize = 100, search, departmentId, status = 'active' } = params;
  const queryClient = useQueryClient();
  const structureQuery = useStructureTree();
  const employeesParams = {
    page,
    pageSize,
    search: search || undefined,
    departmentId: departmentId || undefined,
    status,
    view: 'staff' as const,
  };
  const employeesQueryKey = paginatedEmployeesQueryKey(employeesParams);
  const employeesQuery = usePaginatedEmployeesQuery(employeesParams);
  const countsQuery = useEmployeeCountsQuery(false);

  const employeesResponse = employeesQuery.data || EMPTY_PAGINATED_RESPONSE;
  const counts = countsQuery.data || EMPTY_EMPLOYEE_COUNTS;
  const departments = structureQuery.data?.departments || [];
  const meta: PaginatedMeta = employeesResponse.meta || EMPTY_PAGINATED_META;

  const patchEmployee = useCallback((id: number, patch: Partial<Employee>) => {
    queryClient.setQueryData(employeesQueryKey, (previous: typeof employeesResponse | undefined) => {
      if (!previous) return previous;
      return {
        ...previous,
        data: previous.data.map(employee => (
          employee.id === id ? { ...employee, ...patch } : employee
        )),
      };
    });
  }, [employeesQueryKey, queryClient]);

  const refresh = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: employeesQueryKey }),
      queryClient.invalidateQueries({ queryKey: employeeCountsQueryKey(false) }),
    ]);
  }, [employeesQueryKey, queryClient]);

  return {
    employees: employeesResponse.data,
    departments,
    countsByDepartment: counts.byDepartment,
    loading: employeesQuery.isPending || structureQuery.isPending || countsQuery.isPending,
    meta,
    totalActive: counts.byStatus.active,
    refresh,
    patchEmployee,
  };
};
