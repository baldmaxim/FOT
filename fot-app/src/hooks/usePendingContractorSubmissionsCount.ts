import { useQuery } from '@tanstack/react-query';
import { contractorAdminService } from '../services/contractorService';
import { useAuth } from '../contexts/AuthContext';

export const usePendingContractorSubmissionsCount = (): number => {
  const { canViewPage } = useAuth();
  const canView = canViewPage('/admin/contractor-approvals');

  const q = useQuery({
    queryKey: ['contractor-pending-subs-count'],
    queryFn: () => contractorAdminService.getPendingSubmissionsCount(),
    enabled: canView,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return q.data?.count ?? 0;
};
