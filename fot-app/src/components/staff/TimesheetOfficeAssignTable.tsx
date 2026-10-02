import type { FC } from 'react';
import { Check } from 'lucide-react';
import type { ITimesheetOfficeObject, TimesheetOfficeAssignment } from '../../services/adminService';
import styles from './StaffTimesheetOfficeModal.module.css';

export interface ITimesheetOfficeTableRow {
  id: number;
  full_name: string;
  /** Объект табелирования сейчас; null — «—». */
  label: string | null;
  checked: boolean;
  disabled: boolean;
  /** Назначение с учётом отметки — для списка во вкладке «Сотрудник». */
  assignment: TimesheetOfficeAssignment;
  /** Назначение по данным сервера: закрытый с тех пор объект остаётся видимым пунктом. */
  savedAssignment: TimesheetOfficeAssignment;
}

const OFFICE_VALUE = 'office';

interface IAssignmentSelectProps {
  row: ITimesheetOfficeTableRow;
  objects: readonly ITimesheetOfficeObject[];
  onChange: (id: number, value: TimesheetOfficeAssignment) => void;
}

/**
 * Список «Назначить» вкладки «Сотрудник»: «Не назначено», «Офис», объекты. Назначенный объект,
 * который потом закрыли, виден текущим значением, но выбрать его заново нельзя.
 */
const AssignmentSelect: FC<IAssignmentSelectProps> = ({ row, objects, onChange }) => {
  const saved = row.savedAssignment;
  const closedSaved = saved !== null && saved !== OFFICE_VALUE && !objects.some(object => object.id === saved);
  return (
    <select
      className={`sc-schedule-filter ${styles.assignSelect}`}
      value={row.assignment ?? ''}
      disabled={row.disabled}
      aria-label={`Назначить: ${row.full_name}`}
      onChange={event => onChange(row.id, event.target.value === '' ? null : event.target.value)}
    >
      <option value="">Не назначено</option>
      <option value={OFFICE_VALUE}>Офис</option>
      {closedSaved && <option value={saved} disabled>{row.label ?? saved}</option>}
      {objects.map(object => <option key={object.id} value={object.id}>{object.name}</option>)}
    </select>
  );
};

interface IOfficeToggleProps {
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
}

/**
 * Зелёная галочка и «Офис»: галочка слева, чтобы кнопки стояли в одну линию у правого края;
 * место под галочку занято всегда — строка не прыгает.
 */
const OfficeToggle: FC<IOfficeToggleProps> = ({ checked, disabled, onClick, label }) => (
  <span className={styles.assign}>
    <Check size={18} className={`${styles.check}${checked ? ` ${styles.checkOn}` : ''}`} aria-hidden="true" />
    <button
      type="button"
      className={styles.officeButton}
      aria-pressed={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      Офис
    </button>
  </span>
);

interface ITimesheetOfficeAssignTableProps {
  rows: ITimesheetOfficeTableRow[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** «Офис» всему отделу в шапке «Назначить» (вкладка «Отдел»); null — просто заголовок. */
  header: { checked: boolean; disabled: boolean; onToggle: () => void } | null;
  onToggleRow: (id: number) => void;
  /** Вкладка «Сотрудник»: вместо «Офис» — список назначения из этих объектов. */
  assignment?: {
    objects: readonly ITimesheetOfficeObject[];
    onChange: (id: number, value: TimesheetOfficeAssignment) => void;
  };
}

/**
 * Таблица окна «Режим табелирования» (миграция 291) в стиле «Текущих сотрудников»:
 * ФИО | Текущий объект | Назначить. Клик по «Офис» или выбор в списке только отмечает —
 * пишет «Сохранить».
 */
export const TimesheetOfficeAssignTable: FC<ITimesheetOfficeAssignTableProps> = ({
  rows,
  isLoading,
  isError,
  onRetry,
  header,
  onToggleRow,
  assignment,
}) => (
  <div className={`sc-table-wrap ${styles.tableWrap}`}>
    <table className={`sc-table ${styles.table}`}>
      <colgroup>
        <col />
        <col className={styles.colObject} />
        <col className={assignment ? styles.colAssignSelect : styles.colAssign} />
      </colgroup>
      <thead>
        <tr>
          <th>ФИО</th>
          <th>Текущий объект</th>
          <th>
            {header ? (
              <span className={styles.thAssign}>
                Назначить
                <OfficeToggle
                  checked={header.checked}
                  disabled={header.disabled}
                  onClick={header.onToggle}
                  label="«Офис» всему отделу"
                />
              </span>
            ) : 'Назначить'}
          </th>
        </tr>
      </thead>
      <tbody>
        {isLoading && (
          <tr><td colSpan={3} className={styles.hint}>Загрузка…</td></tr>
        )}
        {isError && !rows && (
          <tr>
            <td colSpan={3}>
              <span className={styles.stateRow}>
                <span className={styles.muted}>Не удалось загрузить</span>
                <button type="button" className={styles.rowButton} onClick={onRetry}>Повторить</button>
              </span>
            </td>
          </tr>
        )}
        {rows && rows.length === 0 && (
          <tr><td colSpan={3} className={styles.hint}>В отделе нет сотрудников</td></tr>
        )}
        {rows?.map(row => (
          <tr key={row.id}>
            <td className={`sc-td-name ${styles.nameCell}`}>{row.full_name}</td>
            <td className={styles.objectCell}>{row.label ?? '—'}</td>
            <td>
              {assignment ? (
                <AssignmentSelect row={row} objects={assignment.objects} onChange={assignment.onChange} />
              ) : (
                <OfficeToggle
                  checked={row.checked}
                  disabled={row.disabled}
                  onClick={() => onToggleRow(row.id)}
                  label={`«Офис»: ${row.full_name}`}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
