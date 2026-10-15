import { useMemo, type FC } from 'react';

import type { EmployeeDepartmentAssignmentFromApi } from '../../services/adminService';
import type { ITimesheetViewAssignment } from '../../services/timesheetViewAccessService';
import styles from '../../pages/admin/Admin.module.css';

interface ITimesheetViewEmployeesTabProps {
  /** Общий список сотрудников панели (действующие). */
  allEmployees: EmployeeDepartmentAssignmentFromApi[];
  /** Сотрудник, которому назначают, — в списке его нет. */
  selfId: number;
  search: string;
  /** Отмеченные сейчас (черновик). */
  selectedIds: number[];
  /** Сохранённые назначения — в том числе уволенные, которых нет в общем списке. */
  assigned: ITimesheetViewAssignment[];
  onToggle: (employeeId: number) => void;
  loading: boolean;
  error: boolean;
}

const MAX_REST = 60;

const normalizeText = (value: string | null | undefined): string => (
  String(value || '')
    .replace(/ /g, ' ')
    .replace(/ё/giu, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
);

/**
 * Вкладка «Просмотр табеля» (миграция 309): чей табель сотрудник видит только на чтение.
 * В отличие от «Человек» человек не становится подчинённым, и смотрящих у него может быть
 * сколько угодно — поэтому отметки «Уже назначен» здесь нет.
 */
export const TimesheetViewEmployeesTab: FC<ITimesheetViewEmployeesTabProps> = ({
  allEmployees,
  selfId,
  search,
  selectedIds,
  assigned,
  onToggle,
  loading,
  error,
}) => {
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const { selected, rest, missing } = useMemo(() => {
    const query = normalizeText(search);
    const matches = (employee: EmployeeDepartmentAssignmentFromApi): boolean => !query
      || normalizeText(employee.full_name).includes(query)
      || normalizeText(employee.position_name).includes(query)
      || normalizeText(employee.department_name).includes(query);
    const filtered = allEmployees.filter(employee => employee.employee_id !== selfId && matches(employee));
    // Как во вкладке «Человек»: сохранённые и отмеченные — сверху и вне лимита, чтобы
    // снятая галочка не уводила человека за пределы списка.
    const pinnedIds = new Set<number>([...assigned.map(row => row.employee_id), ...selectedIds]);
    const candidates = [
      ...filtered.filter(employee => pinnedIds.has(employee.employee_id)),
      ...filtered.filter(employee => !pinnedIds.has(employee.employee_id)).slice(0, MAX_REST),
    ];
    const known = new Set(allEmployees.map(employee => employee.employee_id));
    return {
      selected: candidates.filter(employee => selectedSet.has(employee.employee_id)),
      rest: candidates.filter(employee => !selectedSet.has(employee.employee_id)),
      // Уволенные назначенные: в общем списке их нет, но снять связь должно быть можно.
      missing: assigned.filter(row => !known.has(row.employee_id) && (!query || normalizeText(row.full_name).includes(query))),
    };
  }, [allEmployees, selfId, search, selectedIds, selectedSet, assigned]);

  if (loading) {
    return <div className={styles.departmentAccessEmpty}>Загрузка...</div>;
  }
  if (error) {
    return <div className={styles.departmentAccessEmpty}>Не удалось загрузить список</div>;
  }

  const missingSelected = missing.filter(row => selectedSet.has(row.employee_id));
  const missingRest = missing.filter(row => !selectedSet.has(row.employee_id));
  const selectedCount = selected.length + missingSelected.length;

  if (selectedCount === 0 && rest.length === 0 && missingRest.length === 0) {
    return <div className={styles.departmentAccessEmpty}>Сотрудники не найдены</div>;
  }

  const renderEmployee = (employee: EmployeeDepartmentAssignmentFromApi) => {
    const checked = selectedSet.has(employee.employee_id);
    return (
      <label
        key={employee.employee_id}
        className={`${styles.assignmentPanelPerson} ${checked ? styles.departmentAccessItemChecked : ''}`}
      >
        <input type="checkbox" checked={checked} onChange={() => onToggle(employee.employee_id)} />
        <div className={styles.assignmentPanelPersonInfo}>
          <div className={styles.assignmentPanelPersonName}>{employee.full_name}</div>
          <div className={styles.assignmentPanelPersonMeta}>
            {employee.position_name || 'Должность не указана'}
            {employee.department_name ? ` · ${employee.department_name}` : ''}
          </div>
        </div>
      </label>
    );
  };

  const renderMissing = (row: ITimesheetViewAssignment) => {
    const checked = selectedSet.has(row.employee_id);
    return (
      <label
        key={`missing-${row.employee_id}`}
        className={`${styles.assignmentPanelPerson} ${checked ? styles.departmentAccessItemChecked : ''}`}
      >
        <input type="checkbox" checked={checked} onChange={() => onToggle(row.employee_id)} />
        <div className={styles.assignmentPanelPersonInfo}>
          <div className={styles.assignmentPanelPersonName}>{row.full_name}</div>
          <div className={styles.assignmentPanelPersonMeta}>
            {row.employment_status === 'fired' ? 'Уволен' : 'Нет в списке сотрудников'}
          </div>
        </div>
      </label>
    );
  };

  return (
    <div className={styles.assignmentPanelList}>
      {selectedCount > 0 && (
        <>
          <div className={styles.departmentAccessGroupHeader}>Назначенные ({selectedCount})</div>
          {selected.map(renderEmployee)}
          {missingSelected.map(renderMissing)}
        </>
      )}
      {missingRest.map(renderMissing)}
      {rest.map(renderEmployee)}
    </div>
  );
};
