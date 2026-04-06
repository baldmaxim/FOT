import { useQuery } from '@tanstack/react-query';
import { skudService } from '../services/skudService';
import type { IEmployeePresence } from '../types';

interface IUsePresenceReturn {
  employees: IEmployeePresence[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => void;
}

export const usePresence = (departmentId: string | null): IUsePresenceReturn => {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['presence', departmentId],
    queryFn: () => skudService.getPresence(departmentId!),
    enabled: !!departmentId,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return {
    employees: data || [],
    loading: isLoading,
    error: error ? 'Ошибка загрузки статусов' : null,
    lastUpdated: dataUpdatedAt ? new Date(dataUpdatedAt) : null,
    refresh: () => { refetch(); },
  };
};
