import { timesheetService } from '../../../services/timesheetService';
import { getMonthBounds } from '../../../utils/timesheetApprovalPeriod';

/**
 * Табель отдела для окна дня на вкладках кадров («Выходные», «Корректировки»): те же параметры, что у «Табеля» по
 * отделу — те же окна перевода, замки и часы. Ключ внутри ['timesheet-page']: правка табеля обновляет и его; у обеих
 * вкладок он общий — табель отдела грузится один раз.
 */
export const branchTimesheetKey = (branchId: string, month: string) => (
  ['timesheet-page', 'staff-weekends', branchId, month] as const
);

export const fetchBranchTimesheet = (branchId: string, month: string) => {
  const bounds = getMonthBounds(month);
  return timesheetService.getAll({
    month,
    department_id: branchId,
    from: bounds?.firstDate,
    to: bounds?.lastDate,
    include_objects: true,
    show_fired: true,
    schedule_payload: 'compact',
  });
};
