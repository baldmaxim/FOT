import type { TimesheetExportMode } from '../../services/adminService';

/** Полный текст режима — без сокращений «ТД»/«СКУД». */
export const formatTimesheetModeText = (
  mode: TimesheetExportMode,
  objectName: string | null | undefined,
): string => {
  if (mode === 'current_activity') return 'Текущая деятельность';
  if (mode === 'skud') return 'По СКУД';
  return `Объект: ${objectName || 'не найден'}`;
};

/** Текущий вариант строки — для пометки «сейчас» в правой колонке. */
export interface ITimesheetModeCurrent {
  mode: TimesheetExportMode;
  objectId: string | null;
}

export type TimesheetModeTab = 'department' | 'brigade' | 'employee';
