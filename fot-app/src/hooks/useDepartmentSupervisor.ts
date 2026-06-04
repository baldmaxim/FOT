import { useQuery } from '@tanstack/react-query';
import { timesheetService } from '../services/timesheetService';
import type { IDepartmentSupervisor } from '../types';

export const useDepartmentSupervisor = (departmentId: string | null) =>
  useQuery<IDepartmentSupervisor>({
    queryKey: ['department-supervisor', departmentId],
    queryFn: () => timesheetService.getDepartmentSupervisor(departmentId as string),
    enabled: !!departmentId,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
