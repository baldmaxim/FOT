import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  getTimesheetMonthAccess,
  isTimesheetWindowExempt,
  type ITimesheetMonthAccess,
} from '../utils/timesheetMonthAccess';

export interface IUseTimesheetMonthAccessOptions {
  /**
   * Игнорировать exempt — окно применяется всегда. Для MyMonthTimesheet
   * (Заявления, личный кабинет): даже у админа диапазон ограничен ролью.
   */
  ignoreExempt?: boolean;
  /**
   * Дополнительный гейт. Если false — окно НЕ применяется, даже когда роль
   * не освобождена. Используется страницами с restricted-manager-view
   * (передают isDepartmentScope и т.п.).
   */
  enforceWhen?: boolean;
}

export interface IUseTimesheetMonthAccessResult extends ITimesheetMonthAccess {
  isExempt: boolean;
  isWindowEnforced: boolean;
  minOffset: number;
  maxOffset: number;
}

export const useTimesheetMonthAccess = (
  options?: IUseTimesheetMonthAccessOptions,
): IUseTimesheetMonthAccessResult => {
  const {
    isAdmin,
    hasPermission,
    timesheetMonthsBack,
    timesheetMonthsForward,
  } = useAuth();

  const canManageAllDepartments = isAdmin || hasPermission('data.scope.all');
  const isExempt = isTimesheetWindowExempt({ isAdmin, canManageAllDepartments });

  const ignoreExempt = options?.ignoreExempt ?? false;
  const enforceWhen = options?.enforceWhen;
  const isWindowEnforced = ignoreExempt
    ? true
    : !isExempt && enforceWhen !== false;

  const now = useMemo(() => new Date(), []);

  const access = useMemo(
    () => getTimesheetMonthAccess(isWindowEnforced, timesheetMonthsBack, timesheetMonthsForward, now),
    [isWindowEnforced, timesheetMonthsBack, timesheetMonthsForward, now],
  );

  return {
    ...access,
    isExempt,
    isWindowEnforced,
    minOffset: -access.monthsBack,
    maxOffset: access.monthsForward,
  };
};
