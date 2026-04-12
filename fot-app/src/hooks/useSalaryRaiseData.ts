import { useQuery } from '@tanstack/react-query';
import { salaryRaiseService } from '../services/salaryRaiseService';

export const getMySalaryRaiseRequestsQueryKey = () => ['salary-raise', 'my'] as const;
export const getSalaryRaiseReviewListQueryKey = (filter: 'pending' | 'all', canViewAll: boolean) => ['salary-raise', 'review-list', canViewAll ? filter : 'pending'] as const;
export const getSalaryRaiseRequestQueryKey = (id: number | null) => ['salary-raise', 'request', id] as const;

export const useMySalaryRaiseRequests = () => useQuery({
  queryKey: getMySalaryRaiseRequestsQueryKey(),
  queryFn: () => salaryRaiseService.getMy(),
  staleTime: 30_000,
});

export const useSalaryRaiseReviewList = (filter: 'pending' | 'all', canViewAll: boolean) => useQuery({
  queryKey: getSalaryRaiseReviewListQueryKey(filter, canViewAll),
  queryFn: () => {
    if (filter === 'pending' || !canViewAll) {
      return salaryRaiseService.getPending();
    }
    return salaryRaiseService.getAll();
  },
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const useSalaryRaiseRequest = (id: number | null, enabled = true) => useQuery({
  queryKey: getSalaryRaiseRequestQueryKey(id),
  queryFn: () => salaryRaiseService.getById(id as number),
  enabled: enabled && !!id,
  staleTime: 30_000,
});
