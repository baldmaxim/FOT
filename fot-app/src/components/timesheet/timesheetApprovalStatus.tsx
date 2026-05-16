import type { FC } from 'react';
import { Clock, CheckCircle, XCircle, RotateCcw } from 'lucide-react';
import type { TimesheetApprovalStatus } from '../../services/timesheetApprovalService';

// Вынесено из TimesheetApprovalBar.tsx, чтобы файл-компонент экспортировал
// только компоненты (react-refresh/only-export-components).
export const STATUS_COLORS: Record<TimesheetApprovalStatus, string> = {
  draft: '#6b7280',
  submitted: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  returned: '#f59e0b',
};

export const STATUS_ICONS: Record<TimesheetApprovalStatus, FC<{ size?: number }>> = {
  draft: Clock,
  submitted: Clock,
  approved: CheckCircle,
  rejected: XCircle,
  returned: RotateCcw,
};
