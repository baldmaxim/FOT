import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessCatalogService } from '../services/mtsBusinessCatalogService';

export const getMtsBusinessEmployeesCatalogKey = (accountId?: string) =>
  ['mts-business', 'catalog', 'employees', accountId ?? 'all'] as const;
export const getMtsBusinessAccountsPackagesKey = () => ['mts-business', 'catalog', 'accounts-packages'] as const;

export const useMtsBusinessEmployeesCatalog = (accountId?: string) => useQuery({
  queryKey: getMtsBusinessEmployeesCatalogKey(accountId),
  queryFn: () => mtsBusinessCatalogService.getEmployeesCatalog(accountId),
  staleTime: 5 * 60_000,
});

export const useMtsBusinessAccountsPackages = () => useQuery({
  queryKey: getMtsBusinessAccountsPackagesKey(),
  queryFn: () => mtsBusinessCatalogService.getAccountsPackages(),
  staleTime: 5 * 60_000,
});

export const useRefreshMtsBusinessCatalog = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId?: string) => mtsBusinessCatalogService.refresh(accountId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mts-business', 'catalog'] });
    },
  });
};
