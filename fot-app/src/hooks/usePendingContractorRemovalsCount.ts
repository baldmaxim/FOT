import { useQuery } from '@tanstack/react-query';
import { contractorAdminService } from '../services/contractorService';
import { useAuth } from '../contexts/AuthContext';

export const usePendingContractorRemovalsCount = (): number => {
  const { canViewPage } = useAuth();
  const canView = canViewPage('/admin/contractor-approvals');

  const q = useQuery({
    queryKey: ['contractor-removals-count'],
    queryFn: () => contractorAdminService.getRemovalsCount(),
    enabled: canView,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return q.data?.count ?? 0;
};
