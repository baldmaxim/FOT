import { useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { hasGlobalTimesheetReadScope } from '../utils/globalTimesheetRead';

/**
 * Можно ли открыть отдел в «Табеле» (режим «По отделу»): админ, глобальный скоуп,
 * флаг «просмотр всех отделов» или отдел из managed_department_ids профиля.
 * Одна проверка для ссылки ?dept= и для её применения в табеле — иначе ссылка
 * вела бы табельщицу в чужой отдел, а табель молча открывал бы её собственный.
 */
export const useTimesheetDepartmentAccess = (): ((departmentId: string) => boolean) => {
  const { hasPermission, profile } = useAuth();
  const canOpenAll = profile?.is_admin === true
    || hasPermission('data.scope.all')
    || hasGlobalTimesheetReadScope(profile);
  const managedIds = profile?.managed_department_ids;

  return useCallback(
    (departmentId: string) => canOpenAll || (managedIds ?? []).includes(departmentId),
    [canOpenAll, managedIds],
  );
};
