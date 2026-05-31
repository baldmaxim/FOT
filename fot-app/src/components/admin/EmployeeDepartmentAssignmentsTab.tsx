import { useMemo, useRef, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  adminService,
  type EmployeeDepartmentAssignmentFromApi,
  type IUserSlim,
} from '../../services/adminService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import { getTreeFlatDepartments } from '../../utils/departmentUtils';
import { EmployeeAssignmentPanel } from './EmployeeAssignmentPanel';
import styles from '../../pages/admin/Admin.module.css';

interface IEmployeeDepartmentAssignmentsTabProps {
  allUsers: IUserSlim[];
  allUsersLoading?: boolean;
  onReload: () => Promise<void>;
}

const normalizeAdditionalDepartmentIds = (departmentIds: string[]): string[] => (
  [...new Set(departmentIds.filter(Boolean))]
);

const normalizeText = (value: string | null | undefined): string => (
  String(value || '')
    // eslint-disable-next-line no-irregular-whitespace -- regex намеренно ловит NBSP / narrow no-break space
    .replace(/ /g, ' ')
    .replace(/ё/giu, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
);

export const EmployeeDepartmentAssignmentsTab: FC<IEmployeeDepartmentAssignmentsTabProps> = ({ allUsers, allUsersLoading = false, onReload }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const structureQuery = useStructureTree();
  const [searchQuery, setSearchQuery] = useState('');
  const [hideEmployeesWithoutAssignments, setHideEmployeesWithoutAssignments] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeDepartmentAssignmentFromApi | null>(null);

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
    () => employees.filter(employee => employee.assigned_department_ids.length > 0).length,
    [employees],
  );

  const filteredEmployees = useMemo(() => {
    const normalizedSearch = normalizeText(searchQuery);
    return employees.filter(employee => {
      const additionalDepartmentIds = normalizeAdditionalDepartmentIds(employee.assigned_department_ids || []);
      if (hideEmployeesWithoutAssignments && additionalDepartmentIds.length === 0) {
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
        employee.position_name,
        employee.department_name,
        ...additionalDepartmentIds.map(departmentId => departmentMap.get(departmentId)?.name || null),
      ];

      return searchableParts.some(part => normalizeText(part).includes(normalizedSearch));
    });
  }, [departmentMap, employees, hideEmployeesWithoutAssignments, linkedUserByEmployeeId, searchQuery]);

  // Виртуализация: рендерим только видимые строки. Без неё список из ~8700
  // сотрудников = десятки тысяч DOM-узлов → тяжёлый рендер + расширения браузера
  // сканируют DOM (querySelectorAll) и блокируют main-thread на секунды (INP input delay).
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: filteredEmployees.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 12,
  });

  if (employeesQuery.isError || structureQuery.isError) {
    return <div className={styles.error}>Не удалось загрузить назначения сотрудников</div>;
  }

  const isLoadingList = employeesQuery.isPending || structureQuery.isPending || allUsersLoading;

  const handleSaved = async () => {
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-employees', 'department-access'] }),
        onReload(),
      ]);
    } catch {
      toast.error('Ошибка обновления списка');
    }
  };

  return (
    <div className={styles.importSection}>
      <div className={styles.importIntro}>
        <div>
          <h3>Назначения сотрудников</h3>
          <p>
            Кликните по строке сотрудника, чтобы открыть панель назначений: отделы, бригады или
            прямые подчинённые. Назначения работают и для людей без аккаунта портала: после регистрации
            доступы активируются автоматически.
          </p>
        </div>
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
            checked={hideEmployeesWithoutAssignments}
            onChange={(event) => setHideEmployeesWithoutAssignments(event.target.checked)}
          />
          Скрыть сотрудников без назначений
        </label>
      </div>

      <div className={styles.importSummary}>
        <div>Всего сотрудников: <strong>{isLoadingList && employees.length === 0 ? '…' : employees.length}</strong></div>
        <div>С назначениями: <strong>{isLoadingList && employees.length === 0 ? '…' : employeesWithAssignmentsCount}</strong></div>
        <div>В текущем списке: <strong>{isLoadingList && employees.length === 0 ? '…' : filteredEmployees.length}</strong></div>
      </div>

      {isLoadingList && employees.length === 0 ? (
        <div className={styles.loading}>Загрузка назначений сотрудников...</div>
      ) : filteredEmployees.length === 0 ? (
        <div className={styles.empty}>
          {!hideEmployeesWithoutAssignments || searchQuery.trim()
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

          <div ref={scrollRef} style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {rowVirtualizer.getVirtualItems().map(virtualRow => {
                const employee = filteredEmployees[virtualRow.index];
                const linkedUser = linkedUserByEmployeeId.get(employee.employee_id) || null;
                const additionalDepartmentIds = normalizeAdditionalDepartmentIds(employee.assigned_department_ids ?? []);

                return (
                  <div
                    key={employee.employee_id}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    className={styles.userRow}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <div
                      className={styles.userRowHeader}
                      onClick={() => setSelectedEmployee(employee)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedEmployee(employee);
                        }
                      }}
                    >
                      <div className={styles.userRowInfo}>
                        <div className={styles.userRowName}>
                          {employee.full_name}
                        </div>
                        <div className={styles.userRowEmail}>
                          {employee.position_name || 'Должность не указана'}
                          {employee.department_name ? ` · ${employee.department_name}` : ''}
                          {linkedUser
                            ? <span className={styles.emailConfirmed} style={{ marginLeft: 8 }}>аккаунт: {linkedUser.full_name || linkedUser.email || linkedUser.id}</span>
                            : <span className={styles.emailNotConfirmed} style={{ marginLeft: 8 }}>без аккаунта портала</span>
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
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <EmployeeAssignmentPanel
        isOpen={!!selectedEmployee}
        employee={selectedEmployee}
        allEmployees={employees}
        onClose={() => setSelectedEmployee(null)}
        onSaved={() => void handleSaved()}
      />
    </div>
  );
};
