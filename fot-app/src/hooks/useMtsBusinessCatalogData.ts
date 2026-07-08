import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessCatalogService } from '../services/mtsBusinessCatalogService';

export const getMtsBusinessEmployeesCatalogKey = (accountId?: string) =>
  ['mts-business', 'catalog', 'employees', accountId ?? 'all'] as const;
export const getMtsBusinessAccountsPackagesKey = (accountId?: string) =>
  ['mts-business', 'catalog', 'accounts-packages', accountId ?? 'all'] as const;

export const useMtsBusinessEmployeesCatalog = (accountId?: string) => useQuery({
  queryKey: getMtsBusinessEmployeesCatalogKey(accountId),
  queryFn: () => mtsBusinessCatalogService.getEmployeesCatalog(accountId),
  staleTime: 5 * 60_000,
});

export const useMtsBusinessAccountsPackages = (accountId?: string) => useQuery({
  queryKey: getMtsBusinessAccountsPackagesKey(accountId),
  queryFn: () => mtsBusinessCatalogService.getAccountsPackages(accountId),
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
