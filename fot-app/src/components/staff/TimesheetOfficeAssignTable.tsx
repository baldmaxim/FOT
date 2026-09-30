import type { FC } from 'react';
import { Check } from 'lucide-react';
import styles from './StaffTimesheetOfficeModal.module.css';

export interface ITimesheetOfficeTableRow {
  id: number;
  full_name: string;
  /** Объект табелирования сейчас; null — «—». */
  label: string | null;
  checked: boolean;
  disabled: boolean;
}

interface IOfficeToggleProps {
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
}

/** «Офис» и зелёная галочка рядом; место под галочку занято всегда — строка не прыгает. */
const OfficeToggle: FC<IOfficeToggleProps> = ({ checked, disabled, onClick, label }) => (
  <span className={styles.assign}>
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
    <Check size={18} className={`${styles.check}${checked ? ` ${styles.checkOn}` : ''}`} aria-hidden="true" />
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
}

/**
 * Таблица окна «Режим табелирования» (миграция 291) в стиле «Текущих сотрудников»:
 * ФИО | Текущий объект | Назначить. Клик по «Офис» только отмечает — пишет «Сохранить».
 */
export const TimesheetOfficeAssignTable: FC<ITimesheetOfficeAssignTableProps> = ({
  rows,
  isLoading,
  isError,
  onRetry,
  header,
  onToggleRow,
}) => (
  <div className={`sc-table-wrap ${styles.tableWrap}`}>
    <table className={`sc-table ${styles.table}`}>
      <colgroup>
        <col />
        <col className={styles.colObject} />
        <col className={styles.colAssign} />
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
              <OfficeToggle
                checked={row.checked}
                disabled={row.disabled}
                onClick={() => onToggleRow(row.id)}
                label={`«Офис»: ${row.full_name}`}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
