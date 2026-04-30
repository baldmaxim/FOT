import { type FC, useState } from 'react';
import { Check, Pencil, Trash2 } from 'lucide-react';
import type { IAdminExclusionRow } from '../../services/timesheetService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';

interface IProps {
  rows: IAdminExclusionRow[];
  isPending: boolean;
  onEdit: (employeeId: number, effectiveDate: string) => void;
  onDelete: (row: IAdminExclusionRow) => void;
  /** Показывать ли отдел сотрудника (true для админа). */
  showDepartment?: boolean;
  /** Показывать должность сотрудника отдельной строкой. */
  showPosition?: boolean;
}

const formatDateLabel = (iso: string | null): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}.${m}.${y}`;
};

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export const ExclusionsList: FC<IProps> = ({
  rows,
  isPending,
  onEdit,
  onDelete,
  showDepartment = false,
  showPosition = false,
}) => {
  const [editingEmployeeId, setEditingEmployeeId] = useState<number | null>(null);
  const [draftDate, setDraftDate] = useState('');

  const startEdit = (row: IAdminExclusionRow) => {
    setEditingEmployeeId(row.employee_id);
    setDraftDate(row.exclusion_date || todayIso());
  };

  const cancelEdit = () => {
    setEditingEmployeeId(null);
    setDraftDate('');
  };

  const submit = (row: IAdminExclusionRow) => {
    if (!draftDate || draftDate === row.exclusion_date) {
      cancelEdit();
      return;
    }
    onEdit(row.employee_id, draftDate);
    cancelEdit();
  };

  if (rows.length === 0) {
    return <div className="ts-transfers-empty">Нет исключённых сотрудников</div>;
  }

  return (
    <ul className="ts-transfers-list">
      {rows.map(row => {
        const isEditing = editingEmployeeId === row.employee_id;
        return (
          <li
            key={row.employee_id}
            className={`ts-transfers-row${isEditing ? ' ts-transfers-row--editing' : ''}`}
          >
            <div className="ts-transfers-row-main">
              <div className="ts-transfers-row-name">
                {formatTimesheetEmployeeName(row.employee_full_name)}
                {showPosition && row.employee_position && (
                  <span className="ts-transfers-row-position"> · {row.employee_position}</span>
                )}
              </div>
              <div className="ts-transfers-row-meta">
                {showDepartment && row.department_name
                  ? `Исключён из: ${row.department_name}`
                  : 'Исключён из табеля'}
              </div>
            </div>
            <div className="ts-transfers-row-date">
              {isEditing ? (
                <input
                  type="date"
                  className="ts-transfers-date-input"
                  value={draftDate}
                  onChange={e => setDraftDate(e.target.value)}
                  disabled={isPending}
                />
              ) : (
                <span>{formatDateLabel(row.exclusion_date)}</span>
              )}
            </div>
            <div className="ts-transfers-row-actions">
              {isEditing ? (
                <>
                  <button
                    type="button"
                    className="ts-btn ts-btn--primary"
                    disabled={isPending || !draftDate || draftDate === row.exclusion_date}
                    onClick={() => submit(row)}
                  >
                    <Check size={14} /> Сохранить
                  </button>
                  <button
                    type="button"
                    className="ts-btn"
                    disabled={isPending}
                    onClick={cancelEdit}
                  >
                    Отмена
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ts-btn ts-btn--icon"
                    title="Изменить дату исключения"
                    disabled={isPending}
                    onClick={() => startEdit(row)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="ts-btn ts-btn--icon ts-btn--danger"
                    title="Отменить исключение (вернуть в табель)"
                    disabled={isPending}
                    onClick={() => onDelete(row)}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
};
