import { useCallback } from 'react';
import { usePresenceQuery } from './useEmployeeDirectory';
import { useDocumentVisibility } from './useDocumentVisibility';

interface IUsePresenceReturn {
  employees: import('../types').IEmployeePresence[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => void;
}

export const usePresence = (departmentId: string | null): IUsePresenceReturn => {
  const isVisible = useDocumentVisibility();
  const { data, isLoading, error, dataUpdatedAt, refetch } = usePresenceQuery(departmentId, {
    enabled: !!departmentId,
    refetchInterval: isVisible ? 60_000 : false,
  });
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    employees: data || [],
    loading: isLoading,
    error: error ? 'Ошибка загрузки статусов' : null,
    lastUpdated: dataUpdatedAt ? new Date(dataUpdatedAt) : null,
    refresh,
  };
};
