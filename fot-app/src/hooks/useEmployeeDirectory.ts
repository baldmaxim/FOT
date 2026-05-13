import { useQuery } from '@tanstack/react-query';
import { employeeService, type EmployeeCounts, type PaginatedMeta, type PaginatedParams, type PaginatedResponse } from '../services/employeeService';
import { skudService } from '../services/skudService';
import type { IEmployeePresence, IPresenceByObjectResponse } from '../types';

export const EMPTY_EMPLOYEE_COUNTS: EmployeeCounts = {
  byDepartment: {},
  byStatus: { active: 0, fired: 0 },
};

export const EMPTY_PAGINATED_META: PaginatedMeta = {
  page: 1,
  pageSize: 50,
  total: 0,
  totalPages: 0,
};

export const employeeCountsQueryKey = (archived = false) =>
  ['employees', 'counts', archived ? 'archived' : 'active'] as const;

export const paginatedEmployeesQueryKey = (params: PaginatedParams) =>
  [
    'employees',
    'paginated',
    params.view || 'list',
    params.status || 'active',
    params.departmentId || null,
    params.scheduleId || null,
    params.search || '',
    params.archived ? 'archived' : 'live',
    params.page,
    params.pageSize || 50,
  ] as const;

export const presenceQueryKey = (departmentId?: string | null) =>
  ['presence', departmentId || 'all'] as const;

export const useEmployeeCountsQuery = (archived = false) => {
  return useQuery({
    queryKey: employeeCountsQueryKey(archived),
    queryFn: () => employeeService.getCounts(archived),
    staleTime: 60_000,
  });
};

export const usePaginatedEmployeesQuery = (params: PaginatedParams) => {
  return useQuery({
    queryKey: paginatedEmployeesQueryKey(params),
    queryFn: () => employeeService.getPaginated(params),
    placeholderData: previousData => previousData,
  });
};

interface IUsePresenceQueryOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
}

export const usePresenceQuery = (
  departmentId?: string | null,
  options?: IUsePresenceQueryOptions,
) => {
  return useQuery<IEmployeePresence[]>({
    queryKey: presenceQueryKey(departmentId),
    queryFn: () => skudService.getPresence(departmentId || undefined),
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
};

export const presenceByObjectQueryKey = () => ['presence-by-object'] as const;

interface IUsePresenceByObjectQueryOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
}

export const usePresenceByObjectQuery = (options?: IUsePresenceByObjectQueryOptions) =>
  useQuery<IPresenceByObjectResponse>({
    queryKey: presenceByObjectQueryKey(),
    queryFn: ({ signal }) => skudService.getPresenceByObject(signal),
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? 30_000,
    refetchIntervalInBackground: false,
    staleTime: 25_000,
  });

export const EMPTY_PAGINATED_RESPONSE: PaginatedResponse = {
  data: [],
  meta: EMPTY_PAGINATED_META,
};
