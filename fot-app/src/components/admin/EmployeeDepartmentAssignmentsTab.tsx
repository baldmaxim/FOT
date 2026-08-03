import { useMemo, useRef, useState, type FC } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  adminService,
  type EmployeeDepartmentAssignmentFromApi,
  type IUserSlim,
} from '../../services/adminService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import { getTreeFlatDepartments, findSu10CompanyNode, collectDescendantIds } from '../../utils/departmentUtils';
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
  const structureQuery = useStructureTree();
  // Поиск и фильтры в URL — переживают F5 (replace: true, чтобы не засорять history).
  const [searchParams, setSearchParams] = useSearchParams();
  const searchQuery = searchParams.get('q') || '';
  const hideEmployeesWithoutAssignments = searchParams.get('hideUnassigned') === '1';
  const showWithoutResponsible = searchParams.get('noResp') === '1';
  const setUrlParam = (key: string, value: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };
  // Храним id, а не снапшот строки: после рефетча списка панель получает свежие данные.
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);

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
  // Набор id отделов/бригад внутри компании «ООО СУ-10» — фильтр «без ответственного»
  // показывает только сотрудников из этой папки.
  const su10DepartmentIds = useMemo(() => {
    const nodes = structureQuery.data?.departments || [];
    const company = findSu10CompanyNode(nodes);
    return company ? collectDescendantIds(nodes, new Set([company.id])) : new Set<string>();
  }, [structureQuery.data?.departments]);
  const linkedUserByEmployeeId = useMemo(() => (
    new Map(
      allUsers
        .filter(user => user.employee_id)
        .map(user => [user.employee_id as number, user]),
    )
  ), [allUsers]);

  const employees = employeesQuery.data || [];
  const selectedEmployee = useMemo(
    () => (selectedEmployeeId == null
      ? null
      : employees.find(e => e.employee_id === selectedEmployeeId) ?? null),
    [employees, selectedEmployeeId],
  );
  const employeesWithAssignmentsCount = useMemo(
    () => employees.filter(employee => employee.assigned_department_ids.length > 0).length,
    [employees],
  );
  const employeesWithoutResponsibleCount = useMemo(
    () => employees.filter(employee => (
      employee.has_responsible === false
      && !!employee.org_department_id
      && su10DepartmentIds.has(employee.org_department_id)
    )).length,
    [employees, su10DepartmentIds],
  );

  const filteredEmployees = useMemo(() => {
    const normalizedSearch = normalizeText(searchQuery);
    return employees.filter(employee => {
      const additionalDepartmentIds = normalizeAdditionalDepartmentIds(employee.assigned_department_ids || []);
      if (hideEmployeesWithoutAssignments && additionalDepartmentIds.length === 0) {
        return false;
      }

      // Флаг приходит из API; при отсутствии (старый кэш) трактуем как «есть», чтобы не прятать.
      // Дополнительно ограничиваем выборку папкой «ООО СУ-10».
      if (showWithoutResponsible) {
        if (employee.has_responsible !== false) {
          return false;
        }
        if (!employee.org_department_id || !su10DepartmentIds.has(employee.org_department_id)) {
          return false;
        }
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
  }, [departmentMap, employees, hideEmployeesWithoutAssignments, showWithoutResponsible, su10DepartmentIds, linkedUserByEmployeeId, searchQuery]);

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
      // ['admin-employees','department-access'] инвалидирует сам onReload (reloadUsers).
      await onReload();
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
          onChange={(event) => setUrlParam('q', event.target.value || null)}
          className={styles.nameInput}
          placeholder="Поиск по сотруднику, аккаунту или отделу..."
        />
        <label className={styles.assignmentToggle}>
          <input
            type="checkbox"
            checked={hideEmployeesWithoutAssignments}
            onChange={(event) => setUrlParam('hideUnassigned', event.target.checked ? '1' : null)}
          />
          Скрыть сотрудников без назначений
        </label>
        <label className={styles.assignmentToggle}>
          <input
            type="checkbox"
            checked={showWithoutResponsible}
            onChange={(event) => setUrlParam('noResp', event.target.checked ? '1' : null)}
          />
          Показать сотрудников без ответственного (ООО СУ-10)
        </label>
      </div>

      <div className={styles.importSummary}>
        <div>Всего сотрудников: <strong>{isLoadingList && employees.length === 0 ? '…' : employees.length}</strong></div>
        <div>С назначениями: <strong>{isLoadingList && employees.length === 0 ? '…' : employeesWithAssignmentsCount}</strong></div>
        <div>Без ответственного: <strong>{isLoadingList && employees.length === 0 ? '…' : employeesWithoutResponsibleCount}</strong></div>
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
                      onClick={() => setSelectedEmployeeId(employee.employee_id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedEmployeeId(employee.employee_id);
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
        onClose={() => setSelectedEmployeeId(null)}
        onSaved={() => void handleSaved()}
      />
    </div>
  );
};
