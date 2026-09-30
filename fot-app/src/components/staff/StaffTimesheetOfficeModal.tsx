import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { STAFF_MAIN_OBJECTS_QUERY_KEY } from '../../hooks/useStaffMainObjects';
import { useStaffSectionDepartments } from '../../hooks/useStaffSectionDepartments';
import {
  adminService,
  type ITimesheetOfficeEmployee,
  type ITimesheetOfficeUpdate,
} from '../../services/adminService';
import type { OrgDepartmentNode } from '../../types/organization';
import { filterDepartmentTreeByIds } from '../../utils/departmentUtils';
import { selectableTimesheetOfficeDepartmentIds } from '../../utils/timesheetOfficeDeptFilter';
import { DepartmentTreeSelect } from './DepartmentTreeSelect';
import { TimesheetOfficeDepartmentMembers } from './TimesheetOfficeDepartmentMembers';
import { TimesheetOfficeEmployeeSearch } from './TimesheetOfficeEmployeeSearch';
import styles from './StaffTimesheetOfficeModal.module.css';

const TIMESHEET_OFFICE_QUERY_KEY = ['admin-timesheet-office'] as const;
/** Ключи, где видно объект табелирования: карточка, табель, ЛК, «Статья затрат». */
const TIMESHEET_OBJECT_QUERY_KEYS = [
  'employee', 'timesheet', 'timesheet-page', 'timesheet-object', 'my-timesheet-object', STAFF_MAIN_OBJECTS_QUERY_KEY,
];
const OFFICE_VALUE = 'office';

type Target = 'department' | 'employee';

/** Выбирать можно только разрешённые отделы; их предки остаются серыми заголовками. */
const markAllowed = (nodes: OrgDepartmentNode[], allowed: ReadonlySet<string>): OrgDepartmentNode[] =>
  nodes.map(node => ({
    ...node,
    in_scope: allowed.has(node.id),
    children: markAllowed(node.children ?? [], allowed),
  }));

interface IStaffTimesheetOfficeModalProps {
  /** Дерево отделов в доступе пользователя (scopeDeptTree страницы). */
  deptTree: OrgDepartmentNode[];
  onClose: () => void;
}

/**
 * Окно «Режим табелирования» (миграция 291): «Офис» отделу или сотруднику. Кому «Офис»
 * поставлен здесь, тому выбор объекта в ЛК и табеле закрыт, ночной пересчёт его не меняет.
 */
export const StaffTimesheetOfficeModal: FC<IStaffTimesheetOfficeModalProps> = ({ deptTree, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<Target>('department');
  const [departmentId, setDepartmentId] = useState('');
  const [employee, setEmployee] = useState<ITimesheetOfficeEmployee | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  const dismiss = useOverlayDismiss(close);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const stateQuery = useQuery({
    queryKey: TIMESHEET_OFFICE_QUERY_KEY,
    queryFn: () => adminService.getTimesheetOffice(),
    staleTime: 0,
  });
  const state = stateQuery.data;
  const sectionsQuery = useStaffSectionDepartments();

  // Без служебных корней («Уволенные», «test»): только ветки компаний.
  const selectTree = useMemo(() => {
    const selectable = selectableTimesheetOfficeDepartmentIds(state?.allowed_department_ids ?? [], sectionsQuery.data);
    if (!selectable) return [];
    return markAllowed(filterDepartmentTreeByIds(deptTree, selectable), selectable);
  }, [deptTree, state?.allowed_department_ids, sectionsQuery.data]);

  const submit = async (payload: ITimesheetOfficeUpdate, successText: string): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await adminService.updateTimesheetOffice(payload);
      if (result.changed) toast.success(successText);
      else toast.info('Без изменений');
      void queryClient.invalidateQueries({ queryKey: TIMESHEET_OFFICE_QUERY_KEY });
      for (const key of TIMESHEET_OBJECT_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
      return true;
    } catch (error) {
      toast.error(error instanceof ApiError && error.message ? error.message : 'Не удалось сохранить');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const departmentOffice = state?.departments.some(dept => dept.id === departmentId) ?? false;
  const canSave = !busy && (target === 'department' ? departmentId !== '' && !departmentOffice : employee !== null);

  const handleSave = async (): Promise<void> => {
    if (target === 'department' && departmentId) {
      // Отдел остаётся выбранным: в списке ниже видно, что у всех стал «Офис».
      await submit({ departments: { add: [departmentId] } }, 'Сохранено');
    } else if (target === 'employee' && employee) {
      if (await submit({ employees: { add: [employee.id] } }, 'Сохранено')) setEmployee(null);
    }
  };

  const removeDepartment = (id: string, name: string): void => {
    if (!window.confirm(`Снять «Офис» с отдела «${name}»?`)) return;
    void submit({ departments: { remove: [id] } }, 'Снято');
  };

  const removeEmployee = (id: number, fullName: string): void => {
    if (!window.confirm(`Снять «Офис» с сотрудника «${fullName}»?`)) return;
    void submit({ employees: { remove: [id] } }, 'Снято');
  };

  const assignedCount = (state?.departments.length ?? 0) + (state?.employees.length ?? 0);

  return (
    <div className="sc-overlay" {...dismiss}>
      <div
        className={`sc-modal ${styles.modal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="timesheet-office-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="sc-modal-header">
          <h3 id="timesheet-office-title">Режим табелирования</h3>
          <button className="sc-modal-close" onClick={close} disabled={busy} aria-label="Закрыть">&times;</button>
        </div>

        <div className={styles.body}>
          <section className={styles.form}>
            <div className={`sc-segmented ${styles.segmented}`} role="tablist" aria-label="Кому назначить">
              {(['department', 'employee'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={target === value}
                  className={`sc-seg-btn${target === value ? ' is-active' : ''}`}
                  onClick={() => setTarget(value)}
                  disabled={busy}
                >
                  {value === 'department' ? 'Отдел' : 'Сотрудник'}
                </button>
              ))}
            </div>

            {target === 'department' ? (
              <div className="sc-field">
                <label>Отдел</label>
                <DepartmentTreeSelect
                  departments={selectTree}
                  value={departmentId}
                  onChange={setDepartmentId}
                  isLoading={stateQuery.isLoading || sectionsQuery.isLoading}
                  isError={stateQuery.isError || sectionsQuery.isError}
                  onRetry={() => {
                    void stateQuery.refetch();
                    void sectionsQuery.refetch();
                  }}
                  showAllOption={false}
                  emptyLabel="Выберите отдел"
                  clearable
                />
              </div>
            ) : (
              <div className="sc-field">
                <label>Сотрудник</label>
                <TimesheetOfficeEmployeeSearch value={employee} onChange={setEmployee} disabled={busy} />
              </div>
            )}

            <div className="sc-field">
              <label htmlFor="timesheet-office-object">Объект табелирования</label>
              <select
                id="timesheet-office-object"
                className={styles.select}
                value={OFFICE_VALUE}
                onChange={() => undefined}
                disabled={busy}
              >
                <option value={OFFICE_VALUE}>Офис</option>
              </select>
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={`sc-btn apply ${styles.saveButton}`}
                onClick={() => void handleSave()}
                disabled={!canSave}
              >
                {busy ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </section>

          {target === 'department' && departmentId && (
            <TimesheetOfficeDepartmentMembers
              departmentId={departmentId}
              busy={busy}
              onAssign={id => void submit({ employees: { add: [id] } }, 'Сохранено')}
              onReturn={id => void submit({ employees: { remove: [id] } }, 'Возвращено к автоматическому расчёту')}
            />
          )}

          <section className={styles.assigned} aria-labelledby="timesheet-office-assigned">
            <h4 id="timesheet-office-assigned" className={styles.sectionTitle}>Назначено «Офис»</h4>
            {stateQuery.isLoading && <div className={styles.muted}>Загрузка…</div>}
            {stateQuery.isError && <div className={styles.muted}>Не удалось загрузить</div>}
            {state && assignedCount === 0 && <div className={styles.muted}>Нет назначений</div>}

            {state && state.departments.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupTitle}>Отделы</div>
                <ul className={styles.list}>
                  {state.departments.map(dept => (
                    <li key={dept.id} className={styles.row}>
                      <span className={styles.rowText}>
                        {dept.name}
                        <span className={styles.muted}> · {dept.employees_count} чел.</span>
                      </span>
                      <button
                        type="button"
                        className={styles.removeButton}
                        onClick={() => removeDepartment(dept.id, dept.name)}
                        disabled={busy}
                      >
                        Снять
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {state && state.employees.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupTitle}>Сотрудники</div>
                <ul className={styles.list}>
                  {state.employees.map(item => (
                    <li key={item.id} className={styles.row}>
                      <span className={styles.rowText}>
                        {item.full_name}
                        {item.department && <span className={styles.muted}> · {item.department}</span>}
                      </span>
                      <button
                        type="button"
                        className={styles.removeButton}
                        onClick={() => removeEmployee(item.id, item.full_name)}
                        disabled={busy}
                      >
                        Снять
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
