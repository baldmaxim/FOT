import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { employeeService } from '../services/employeeService';
import type { Employee } from '../types';

export const useMyEmployee = (enabled: boolean = true) => {
  const { profile } = useAuth();
  const employeeId = profile?.employee_id ?? null;

  return useQuery<Employee | null>({
    queryKey: ['my-employee', employeeId],
    queryFn: () => (employeeId ? employeeService.getById(employeeId) : Promise.resolve(null)),
    enabled: enabled && !!employeeId,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });
};
