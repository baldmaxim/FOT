import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useStructureTree } from './useStructure';
import { getSortedFlatDepartments, type IFlatDepartmentOption } from '../utils/departmentUtils';

interface UseManagedDepartmentsOptions {
  enabled?: boolean;
}

export const useManagedDepartments = (options?: UseManagedDepartmentsOptions) => {
  const { hasPermission, profile } = useAuth();
  const isAdmin = profile?.is_admin === true;
  const isAdminLike = isAdmin || hasPermission('data.scope.all');
  const hasManagedDepartmentsRaw = (profile?.managed_department_ids?.filter(Boolean).length ?? 0) > 0;
  const hasDirectReports = profile?.has_direct_reports === true;
  // Руководитель = не-админ и не рядовой сотрудник (employee_variant null у ролей head/hr/etc).
  // Даже если у него СЕЙЧАС нет назначенных отделов (например, админ снял назначение),
  // scope должен оставаться включённым — иначе UI рисует ему «всё» как суперадмину.
  const isManagerRole = !isAdminLike && !profile?.is_admin && profile?.employee_variant == null;
  const isDepartmentScope = !isAdminLike && (hasPermission('data.scope.department') || hasManagedDepartmentsRaw || hasDirectReports || isManagerRole);
  const structureQuery = useStructureTree(options?.enabled ?? true);

  const managedDepartmentIds = useMemo(() => {
    const ids = profile?.managed_department_ids?.filter(Boolean) || [];
    return [...new Set(ids)];
  }, [profile?.managed_department_ids]);

  const allDepartments = useMemo<IFlatDepartmentOption[]>(
    () => getSortedFlatDepartments(structureQuery.data?.departments || []),
    [structureQuery.data],
  );

  const managedDepartments = useMemo(() => {
    if (!isDepartmentScope) {
      return allDepartments;
    }
    return allDepartments.filter(department => managedDepartmentIds.includes(department.id));
  }, [allDepartments, isDepartmentScope, managedDepartmentIds]);

  // Safe-pick: если `profile.department_id` (рабочий отдел по должности) не входит
  // в managed (отделы, которыми руководитель управляет) — берём первый managed.
  // Иначе страницы шлют в API department_id, который бэк отвергает как «не в scope».
  // Для руководителя без назначений (isDepartmentScope && managed пуст) — null,
  // чтобы UI не показывал «свой» отдел сотрудника как будто он им управляет.
  const primaryDepartmentId = (() => {
    const own = profile?.department_id || null;
    if (isDepartmentScope && managedDepartmentIds.length === 0) return null;
    if (managedDepartmentIds.length === 0) return own;
    if (own && managedDepartmentIds.includes(own)) return own;
    return managedDepartmentIds[0];
  })();
  const managedDepartmentNameById = useMemo(
    () => new Map(managedDepartments.map(department => [department.id, department.name])),
    [managedDepartments],
  );

  return {
    isDepartmentScope,
    isDirectReportsOnly: isDepartmentScope && managedDepartmentIds.length === 0 && hasDirectReports,
    managedDepartmentIds,
    managedDepartments,
    managedDepartmentNameById,
    primaryDepartmentId,
    mode: managedDepartmentIds.length > 1 ? 'multi' : 'single' as 'single' | 'multi',
    structureQuery,
  };
};
