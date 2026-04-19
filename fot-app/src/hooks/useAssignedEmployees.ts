import { useQuery } from '@tanstack/react-query';
import { timesheetService } from '../services/timesheetService';
import type { IAssignedEmployeeSummary } from '../types';

export const useAssignedEmployees = (enabled = true) =>
  useQuery<IAssignedEmployeeSummary[]>({
    queryKey: ['assigned-employees'],
    queryFn: () => timesheetService.listAssignedEmployees(),
    enabled,
  });
