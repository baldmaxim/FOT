import { type FC, useState } from 'react';
import { ArrowRightLeft, Check, Pencil, Trash2 } from 'lucide-react';
import type { IAdminTransferRow } from '../../services/timesheetService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';

export interface IDeptOption {
  id: string;
  name: string;
}

export interface ITransferEditPatch {
  effective_from?: string;
  to_department_id?: string;
  from_department_id?: string;
}

interface IProps {
  rows: IAdminTransferRow[];
  deptOptions: IDeptOption[];
  isPending: boolean;
  onEdit: (assignmentNewId: string, assignmentOldId: string, patch: ITransferEditPatch) => void;
  onDelete: (row: IAdminTransferRow) => void;
  /** Показывать ли колонку «откуда → куда» (true для админа) или просто «куда» (false для tab внутри отдела). */
  showFromDepartment?: boolean;
  /** Показывать должность сотрудника отдельной строкой. */
  showPosition?: boolean;
}

const formatDateLabel = (iso: string | null): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}.${m}.${y}`;
};

export const TransfersList: FC<IProps> = ({
  rows,
  deptOptions,
  isPending,
  onEdit,
  onDelete,
  showFromDepartment = false,
  showPosition = false,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftDate, setDraftDate] = useState('');
  const [draftToDeptId, setDraftToDeptId] = useState('');
  const [draftFromDeptId, setDraftFromDeptId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const startEdit = (row: IAdminTransferRow) => {
    setEditingId(row.assignment_new_id);
    setDraftDate(row.transfer_date);
    setDraftToDeptId(row.to_department_id);
    setDraftFromDeptId(row.from_department_id);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftDate('');
    setDraftToDeptId('');
    setDraftFromDeptId('');
    setError(null);
  };

  const submit = (row: IAdminTransferRow) => {
    const patch: ITransferEditPatch = {};
    if (draftDate && draftDate !== row.transfer_date) patch.effective_from = draftDate;
    if (draftToDeptId && draftToDeptId !== row.to_department_id) patch.to_department_id = draftToDeptId;
    if (draftFromDeptId && draftFromDeptId !== row.from_department_id) patch.from_department_id = draftFromDeptId;
    if (!patch.effective_from && !patch.to_department_id && !patch.from_department_id) {
      cancelEdit();
      return;
    }
    if (patch.to_department_id && patch.from_department_id && patch.to_department_id === patch.from_department_id) {
      setError('Отдел назначения не может совпадать с исходным');
      return;
    }
    onEdit(row.assignment_new_id, row.assignment_old_id, patch);
    cancelEdit();
  };

  if (rows.length === 0) {
    return <div className="ts-transfers-empty">Нет переведённых сотрудников</div>;
  }

  return (
    <ul className="ts-transfers-list">
      {error && <li className="ts-transfers-error">{error}</li>}
      {rows.map(row => {
        const isEditing = editingId === row.assignment_new_id;
        const fromMissing = !deptOptions.some(d => d.id === row.from_department_id);
        const toMissing = !deptOptions.some(d => d.id === row.to_department_id);
        return (
          <li
            key={row.assignment_new_id}
            className={`ts-transfers-row${isEditing ? ' ts-transfers-row--editing ts-transfers-row--expanded' : ''}`}
          >
            <div className="ts-transfers-row-main">
              <div className="ts-transfers-row-name">
                {formatTimesheetEmployeeName(row.employee_full_name)}
                {showPosition && row.employee_position && (
                  <span className="ts-transfers-row-position"> · {row.employee_position}</span>
                )}
              </div>
              <div className="ts-transfers-row-meta">
                {showFromDepartment && (
                  <>
                    <ArrowRightLeft size={12} /> {row.from_department_name || '—'} →{' '}
                  </>
                )}
                {row.to_department_name || '—'}
              </div>
            </div>
            <div className="ts-transfers-row-date">
              <span>{formatDateLabel(row.transfer_date)}</span>
            </div>
            <div className="ts-transfers-row-actions">
              {!isEditing && (
                <>
                  <button
                    type="button"
                    className="ts-btn ts-btn--icon"
                    title="Изменить дату или отдел"
                    disabled={isPending}
                    onClick={() => startEdit(row)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="ts-btn ts-btn--icon ts-btn--danger"
                    title="Полностью отменить перевод"
                    disabled={isPending}
                    onClick={() => onDelete(row)}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
            {isEditing && (
              <div className="ts-transfers-edit">
                <div className="ts-transfers-edit-fields">
                  <label className="ts-transfers-edit-field">
                    <span className="ts-transfers-edit-label">Дата перевода</span>
                    <input
                      type="date"
                      className="ts-transfers-date-input"
                      value={draftDate}
                      onChange={e => setDraftDate(e.target.value)}
                      disabled={isPending}
                    />
                  </label>
                  <label className="ts-transfers-edit-field">
                    <span className="ts-transfers-edit-label">Исходный отдел</span>
                    <select
                      className="ts-transfers-dept-select"
                      value={draftFromDeptId}
                      onChange={e => setDraftFromDeptId(e.target.value)}
                      disabled={isPending}
                    >
                      {fromMissing && (
                        <option value={row.from_department_id} disabled>
                          {row.from_department_name || '—'}
                        </option>
                      )}
                      {deptOptions.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="ts-transfers-edit-field">
                    <span className="ts-transfers-edit-label">Отдел назначения</span>
                    <select
                      className="ts-transfers-dept-select"
                      value={draftToDeptId}
                      onChange={e => setDraftToDeptId(e.target.value)}
                      disabled={isPending}
                    >
                      {toMissing && (
                        <option value={row.to_department_id} disabled>
                          {row.to_department_name || '—'}
                        </option>
                      )}
                      {deptOptions.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="ts-transfers-edit-actions">
                  <button
                    type="button"
                    className="ts-btn ts-btn--primary"
                    disabled={isPending || !draftDate}
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
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
