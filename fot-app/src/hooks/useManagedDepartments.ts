import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useStructureTree } from './useStructure';
import { getSortedFlatDepartments, type IFlatDepartmentOption } from '../utils/departmentUtils';

interface UseManagedDepartmentsOptions {
  enabled?: boolean;
}

export const useManagedDepartments = (options?: UseManagedDepartmentsOptions) => {
  const { hasPermission, profile } = useAuth();
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
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

  const primaryDepartmentId = profile?.department_id || managedDepartmentIds[0] || null;
  const managedDepartmentNameById = useMemo(
    () => new Map(managedDepartments.map(department => [department.id, department.name])),
    [managedDepartments],
  );

  return {
    isDepartmentScope,
    managedDepartmentIds,
    managedDepartments,
    managedDepartmentNameById,
    primaryDepartmentId,
    mode: managedDepartmentIds.length > 1 ? 'multi' : 'single' as 'single' | 'multi',
    structureQuery,
  };
};
