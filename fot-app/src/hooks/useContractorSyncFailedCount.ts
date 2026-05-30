import { useQuery } from '@tanstack/react-query';
import { contractorAdminService } from '../services/contractorService';
import { useAuth } from '../contexts/AuthContext';

/** Кол-во застрявших отзывов (sigur_sync_state='failed') — для бейджа на «Мониторинге». */
export const useContractorSyncFailedCount = (): number => {
  const { canViewPage } = useAuth();
  const canView = canViewPage('/admin/contractor-approvals');

  const q = useQuery({
    queryKey: ['contractor-sync-failed'],
    queryFn: () => contractorAdminService.listSyncFailed(),
    enabled: canView,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return q.data?.length ?? 0;
};
