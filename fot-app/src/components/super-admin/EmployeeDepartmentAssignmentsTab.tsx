import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminService,
  type EmployeeDepartmentAssignmentFromApi,
} from '../../services/adminService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import type { IUserFromApi } from './AllUsersTab';
import { getTreeFlatDepartments } from '../../utils/departmentUtils';
import styles from '../../pages/super-admin/SuperAdmin.module.css';

interface IEmployeeDepartmentAssignmentsTabProps {
  allUsers: IUserFromApi[];
  onReload: () => Promise<void>;
}

const normalizeAdditionalDepartmentIds = (departmentIds: string[]): string[] => (
  [...new Set(departmentIds.filter(Boolean))]
);

const areDepartmentSelectionsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
};

const normalizeText = (value: string | null | undefined): string => (
  String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/ё/giu, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
);

export const EmployeeDepartmentAssignmentsTab: FC<IEmployeeDepartmentAssignmentsTabProps> = ({ allUsers, onReload }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const structureQuery = useStructureTree();
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAllEmployees, setShowAllEmployees] = useState(false);
  const [departmentAccessDrafts, setDepartmentAccessDrafts] = useState<Record<number, string[]>>({});
  const [departmentAccessQuery, setDepartmentAccessQuery] = useState<Record<number, string>>({});
  const [savingEmployeeId, setSavingEmployeeId] = useState<number | null>(null);
  const employeesQuery = useQuery<EmployeeDepartmentAssignmentFromApi[]>({
    queryKey: ['admin-employees', 'department-access'],
    queryFn: () => adminService.getEmployeeDepartmentAssignments(),
    staleTime: 30_000,
  });

  const flatDepts = useMemo(
    () => getTreeFlatDepartments(structureQuery.data?.departments || []),
    [structureQuery.data?.departments],
  );
  const departmentMap = useMemo(
    () => new Map(flatDepts.map(department => [department.id, department])),
    [flatDepts],
  );
  const linkedUserByEmployeeId = useMemo(() => (
    new Map(
      allUsers
        .filter(user => user.employee_id)
        .map(user => [user.employee_id as number, user]),
    )
  ), [allUsers]);

  const employees = employeesQuery.data || [];
  const employeesWithAssignmentsCount = useMemo(
    () => employees.filter(employee => employee.additional_department_ids.length > 0).length,
    [employees],
  );

  const filteredEmployees = useMemo(() => {
    const normalizedSearch = normalizeText(searchQuery);
    return employees.filter(employee => {
      const additionalDepartmentIds = normalizeAdditionalDepartmentIds(employee.additional_department_ids || []);
      if (!showAllEmployees && additionalDepartmentIds.length === 0) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const linkedUser = linkedUserByEmployeeId.get(employee.employee_id) || null;
      const searchableParts = [
        employee.full_name,
        linkedUser?.full_name,
        linkedUser?.email,
        employee.department_id ? departmentMap.get(employee.department_id)?.name : null,
        ...additionalDepartmentIds.map(departmentId => departmentMap.get(departmentId)?.name || null),
      ];

      return searchableParts.some(part => normalizeText(part).includes(normalizedSearch));
    });
  }, [departmentMap, employees, linkedUserByEmployeeId, searchQuery, showAllEmployees]);

  const getAdditionalDepartmentIds = (employee: EmployeeDepartmentAssignmentFromApi): string[] => (
    normalizeAdditionalDepartmentIds(
      departmentAccessDrafts[employee.employee_id] ?? employee.additional_department_ids ?? [],
    )
  );

  const handleDepartmentAccessToggle = (employee: EmployeeDepartmentAssignmentFromApi, departmentId: string) => {
    const currentDepartmentIds = getAdditionalDepartmentIds(employee);
    const nextDepartmentIds = currentDepartmentIds.includes(departmentId)
      ? currentDepartmentIds.filter(id => id !== departmentId)
      : [...currentDepartmentIds, departmentId];

    setDepartmentAccessDrafts(prev => ({
      ...prev,
      [employee.employee_id]: normalizeAdditionalDepartmentIds(nextDepartmentIds),
    }));
  };

  const handleDepartmentAccessReset = (employee: EmployeeDepartmentAssignmentFromApi) => {
    setDepartmentAccessDrafts(prev => ({
      ...prev,
      [employee.employee_id]: normalizeAdditionalDepartmentIds(employee.additional_department_ids ?? []),
    }));
    setDepartmentAccessQuery(prev => ({
      ...prev,
      [employee.employee_id]: '',
    }));
  };

  const handleDepartmentAccessSave = async (employee: EmployeeDepartmentAssignmentFromApi) => {
    const additionalDepartmentIds = getAdditionalDepartmentIds(employee);
    setSavingEmployeeId(employee.employee_id);
    try {
      const response = await adminService.updateEmployeeDepartmentAccess(employee.employee_id, additionalDepartmentIds);
      setDepartmentAccessDrafts(prev => ({
        ...prev,
        [employee.employee_id]: normalizeAdditionalDepartmentIds(response.additional_department_ids),
      }));
      toast.success('Назначения сотрудника сохранены');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-employees', 'department-access'] }),
        onReload(),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения назначений сотрудника');
    } finally {
      setSavingEmployeeId(null);
    }
  };

  if (employeesQuery.isPending || structureQuery.isPending) {
    return <div className={styles.loading}>Загрузка назначений сотрудников...</div>;
  }

  if (employeesQuery.isError || structureQuery.isError) {
    return <div className={styles.error}>Не удалось загрузить назначения сотрудников</div>;
  }

  return (
    <div className={styles.importSection}>
      <div className={styles.importIntro}>
        <div>
          <h3>Назначения сотрудников</h3>
          <p>
            Здесь назначаются отделы и бригады, за которые сотрудник отвечает как руководитель.
            Без явного назначения сотрудник не видит ни одного отдела в табелях и связанных разделах.
            Назначения работают и для людей без аккаунта портала: после регистрации доступы активируются автоматически.
          </p>
        </div>
        <div className={styles.assignmentFilters}>
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className={styles.nameInput}
            placeholder="Поиск по сотруднику, аккаунту или отделу..."
          />
          <label className={styles.assignmentToggle}>
            <input
              type="checkbox"
              checked={showAllEmployees}
              onChange={(event) => setShowAllEmployees(event.target.checked)}
            />
            Показать всех сотрудников
          </label>
        </div>
      </div>

      <div className={styles.importSummary}>
        <div>Всего сотрудников: <strong>{employees.length}</strong></div>
        <div>С назначениями: <strong>{employeesWithAssignmentsCount}</strong></div>
        <div>В текущем списке: <strong>{filteredEmployees.length}</strong></div>
      </div>

      {filteredEmployees.length === 0 ? (
        <div className={styles.empty}>
          {showAllEmployees || searchQuery.trim()
            ? 'По текущему фильтру сотрудники не найдены'
            : 'Пока нет сотрудников с дополнительными назначениями'}
        </div>
      ) : (
        <div className={styles.userListCompact}>
          <div className={styles.userListTableHeader}>
            <span>Сотрудник</span>
            <span>Аккаунт</span>
            <span>Назначено отделов</span>
            <span></span>
          </div>

          {filteredEmployees.map(employee => {
            const isExpanded = expandedEmployeeId === employee.employee_id;
            const linkedUser = linkedUserByEmployeeId.get(employee.employee_id) || null;
            const additionalDepartmentIds = getAdditionalDepartmentIds(employee);
            const initialDepartmentIds = normalizeAdditionalDepartmentIds(employee.additional_department_ids ?? []);
            const hasDepartmentAccessChanges = !areDepartmentSelectionsEqual(additionalDepartmentIds, initialDepartmentIds);
            const departmentSearchQuery = normalizeText(departmentAccessQuery[employee.employee_id] || '');
            const filteredAdditionalDepartments = flatDepts.filter(department => (
              !departmentSearchQuery || normalizeText(department.name).includes(departmentSearchQuery)
            ));
            const selectedDepartments = additionalDepartmentIds
              .map(departmentId => departmentMap.get(departmentId) || {
                id: departmentId,
                name: `Не найденный отдел (${departmentId.slice(0, 8)})`,
                level: 0,
              });

            return (
              <div key={employee.employee_id} className={`${styles.userRow} ${isExpanded ? styles.expanded : ''}`}>
                <div
                  className={styles.userRowHeader}
                  onClick={() => setExpandedEmployeeId(prev => prev === employee.employee_id ? null : employee.employee_id)}
                >
                  <div className={styles.userRowInfo}>
                    <div className={styles.userRowName}>
                      {employee.full_name}
                    </div>
                    <div className={styles.userRowEmail}>
                      ID {employee.employee_id}
                      {linkedUser
                        ? <span className={styles.emailConfirmed}>аккаунт: {linkedUser.full_name || linkedUser.email || linkedUser.id}</span>
                        : <span className={styles.emailNotConfirmed}>без аккаунта портала</span>
                      }
                    </div>
                  </div>

                  <div className={styles.userRowMeta}>
                    <span className={styles.userRowRole}>
                      {linkedUser ? 'Есть аккаунт' : 'Без аккаунта'}
                    </span>
                    <div className={styles.userRowStatusCell}>
                      <span className={styles.departmentAccessCount}>
                        {additionalDepartmentIds.length}
                      </span>
                    </div>
                  </div>

                  <div className={styles.expandIcon}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </div>

                {isExpanded && (
                  <div className={styles.userRowControls}>
                    <div className={styles.departmentAccessSection}>
                      <div className={styles.departmentAccessHeader}>
                        <div>
                          <div className={styles.departmentAccessTitle}>Назначенные отделы и бригады</div>
                          <div className={styles.departmentAccessHint}>
                            Сотрудник видит табели и управляет только теми отделами, которые назначены здесь.
                          </div>
                        </div>
                        <div className={styles.departmentAccessCount}>
                          {additionalDepartmentIds.length} выбрано
                        </div>
                      </div>

                      <div className={styles.departmentAccessPrimary}>
                        Аккаунт портала:{' '}
                        <strong>{linkedUser ? (linkedUser.full_name || linkedUser.email || linkedUser.id) : 'ещё не зарегистрирован'}</strong>
                      </div>

                      <input
                        type="text"
                        placeholder="Поиск отдела или бригады..."
                        value={departmentAccessQuery[employee.employee_id] || ''}
                        onChange={(event) => setDepartmentAccessQuery(prev => ({
                          ...prev,
                          [employee.employee_id]: event.target.value,
                        }))}
                        className={`${styles.nameInput} ${styles.departmentAccessSearch}`}
                      />

                      {selectedDepartments.length > 0 && (
                        <div className={styles.departmentAccessTags}>
                          {selectedDepartments.map(department => (
                            <button
                              key={department.id}
                              type="button"
                              className={styles.departmentAccessTag}
                              onClick={() => handleDepartmentAccessToggle(employee, department.id)}
                            >
                              {department.name}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className={styles.departmentAccessList}>
                        {filteredAdditionalDepartments.length > 0 ? (
                          filteredAdditionalDepartments.map(department => {
                            if (department.hasChildren) {
                              return (
                                <div
                                  key={department.id}
                                  className={styles.departmentAccessGroupHeader}
                                  style={{ paddingLeft: `${department.level * 14}px` }}
                                >
                                  {department.name}
                                </div>
                              );
                            }
                            const checked = additionalDepartmentIds.includes(department.id);
                            return (
                              <label
                                key={department.id}
                                className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => handleDepartmentAccessToggle(employee, department.id)}
                                />
                                <span
                                  className={styles.departmentAccessItemLabel}
                                  style={{ paddingLeft: `${department.level * 14}px` }}
                                >
                                  {department.name}
                                </span>
                              </label>
                            );
                          })
                        ) : (
                          <div className={styles.departmentAccessEmpty}>
                            {departmentSearchQuery ? 'По запросу ничего не найдено' : 'Нет доступных подразделений'}
                          </div>
                        )}
                      </div>

                      <div className={styles.departmentAccessActions}>
                        <button
                          type="button"
                          className={styles.cancelBtn}
                          onClick={() => handleDepartmentAccessReset(employee)}
                          disabled={!hasDepartmentAccessChanges || savingEmployeeId === employee.employee_id}
                        >
                          Сбросить
                        </button>
                        <button
                          type="button"
                          className={styles.saveBtn}
                          onClick={() => void handleDepartmentAccessSave(employee)}
                          disabled={!hasDepartmentAccessChanges || savingEmployeeId === employee.employee_id}
                        >
                          {savingEmployeeId === employee.employee_id ? 'Сохраняю...' : 'Сохранить назначения'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
