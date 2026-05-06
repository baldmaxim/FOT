/**
 * Диалоги управления Sigur-структурой и сотрудниками.
 *
 * Извлечено из SigurEmployeesTab.tsx (Волна 3 декомпозиции).
 * Три controlled-компонента: department CRUD/move, delete departments,
 * employee mass-move. Все state живёт в родителе (через DialogState type
 * из sigurEmployeesTab.helpers), компоненты — чисто display + dispatch.
 *
 * employeeDialog (create/edit с Sigur-suggestions подсистемой) — НЕ вынесен:
 * требует прокидывания ~10 query-зависимых props, отдельный PR.
 */
import { Trash2 } from 'lucide-react';
import type { Dispatch, FC, SetStateAction } from 'react';
import { ProgressBar } from '../../ui/ProgressBar';
import type {
  DeleteDepartmentsDialogState,
  DepartmentDialogState,
  EmployeeMoveDialogState,
} from './sigurEmployeesTab.helpers';

interface IDeptOption {
  id: number;
  name: string;
  level: number;
}

// ─── DepartmentDialog (create/rename/move) ─────────────────────────────────

export interface IDepartmentDialogProps {
  dialog: NonNullable<DepartmentDialogState>;
  setDialog: Dispatch<SetStateAction<DepartmentDialogState>>;
  saving: boolean;
  onSave: () => void;
  moveTargetOptions: IDeptOption[];
}

export const DepartmentDialog: FC<IDepartmentDialogProps> = ({
  dialog,
  setDialog,
  saving,
  onSave,
  moveTargetOptions,
}) => {
  return (
    <div className="ep-modal-overlay" onClick={() => setDialog(null)}>
      <div className="ep-modal" onClick={event => event.stopPropagation()}>
        <div className="ep-modal-header">
          <div className="ep-modal-heading">
            <div className="ep-modal-title">
              {dialog.mode === 'create' && 'Новый отдел Sigur'}
              {dialog.mode === 'rename' && 'Переименовать отдел Sigur'}
              {dialog.mode === 'move' && `Переместить ${dialog.departmentIds.length} ${dialog.departmentIds.length === 1 ? 'отдел' : 'отдела'}`}
            </div>
          </div>
        </div>
        <div className="ep-modal-body">
          {dialog.mode === 'create' || dialog.mode === 'rename' ? (
            <label>
              Название
              <input
                className="ep-modal-input"
                value={dialog.name}
                onChange={event => setDialog(prev => (
                  prev && (prev.mode === 'create' || prev.mode === 'rename')
                    ? { ...prev, name: event.target.value }
                    : prev
                ))}
              />
            </label>
          ) : (
            <label>
              Новый родитель
              <select
                className="ep-modal-select"
                value={dialog.parentId == null ? '' : String(dialog.parentId)}
                onChange={event => setDialog(prev => (
                  prev && prev.mode === 'move'
                    ? { ...prev, parentId: event.target.value ? Number(event.target.value) : null }
                    : prev
                ))}
              >
                <option value="">В корень</option>
                {moveTargetOptions.map(option => (
                  <option key={option.id} value={option.id}>
                    {'  '.repeat(option.level)}{option.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="ep-modal-footer">
          <button className="ep-modal-btn secondary" onClick={() => setDialog(null)}>
            Отмена
          </button>
          <button className="ep-modal-btn primary" onClick={onSave} disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── DeleteDepartmentsDialog ───────────────────────────────────────────────

export interface IDeleteDepartmentsDialogProps {
  dialog: NonNullable<DeleteDepartmentsDialogState>;
  setDialog: Dispatch<SetStateAction<DeleteDepartmentsDialogState>>;
  deleting: boolean;
  onConfirm: () => void;
}

export const DeleteDepartmentsDialog: FC<IDeleteDepartmentsDialogProps> = ({
  dialog,
  setDialog,
  deleting,
  onConfirm,
}) => {
  return (
    <div className="ep-modal-overlay" onClick={() => !deleting && setDialog(null)}>
      <div className="ep-modal" onClick={event => event.stopPropagation()}>
        <div className="ep-modal-header">
          <div className="ep-modal-heading">
            <div className="ep-modal-title">
              {dialog.departmentIds.length === 1
                ? `Удалить отдел «${dialog.names[0] ?? ''}»?`
                : `Удалить ${dialog.departmentIds.length} отдел(ов)?`}
            </div>
          </div>
        </div>
        <div className="ep-modal-body">
          {dialog.names.length > 1 && (
            <ul className="ep-delete-list">
              {dialog.names.map((name, index) => (
                <li key={`${name}-${index}`}>{name}</li>
              ))}
            </ul>
          )}
          <div className="ep-danger-note">
            <Trash2 size={18} />
            <div>
              {dialog.hasChildren ? (
                <>
                  <div><b>Будет удалена вся ветка</b> — вместе со вложенными отделами{dialog.totalChildDepts > 0 ? ` (${dialog.totalChildDepts} шт.)` : ''}.</div>
                  {dialog.totalEmployees > 0 && (
                    <div style={{ marginTop: 6 }}>
                      Сотрудники ({dialog.totalEmployees}) будут перенесены в родительский отдел.
                    </div>
                  )}
                </>
              ) : dialog.directEmployees > 0 ? (
                <div>
                  В отделе {dialog.directEmployees} сотрудник(ов). Они будут перенесены в родительский отдел.
                </div>
              ) : (
                <div>Отдел пуст — будет удалён без последствий.</div>
              )}
            </div>
          </div>
        </div>
        <div className="ep-modal-footer">
          <button
            className="ep-modal-btn secondary"
            onClick={() => setDialog(null)}
            disabled={deleting}
          >
            Отмена
          </button>
          <button
            className="ep-modal-btn danger"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? 'Удаление...' : 'Удалить'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── EmployeeMoveDialog ────────────────────────────────────────────────────

export interface IEmployeeMoveDialogProps {
  dialog: NonNullable<EmployeeMoveDialogState>;
  setDialog: Dispatch<SetStateAction<EmployeeMoveDialogState>>;
  saving: boolean;
  onSave: () => void;
  departmentOptions: IDeptOption[];
  progress: { processed: number; total: number; failed: number } | null;
}

export const EmployeeMoveDialog: FC<IEmployeeMoveDialogProps> = ({
  dialog,
  setDialog,
  saving,
  onSave,
  departmentOptions,
  progress,
}) => {
  return (
    <div className="ep-modal-overlay" onClick={() => { if (!saving) setDialog(null); }}>
      <div className="ep-modal" onClick={event => event.stopPropagation()}>
        <div className="ep-modal-header">
          <div className="ep-modal-heading">
            <div className="ep-modal-title">{`Переместить ${dialog.employeeIds.length} сотрудников`}</div>
          </div>
        </div>
        <div className="ep-modal-body">
          <label>
            Целевой отдел
            <select
              className="ep-modal-select"
              value={dialog.departmentId}
              onChange={event => setDialog(prev => prev ? { ...prev, departmentId: event.target.value } : prev)}
              disabled={saving}
            >
              <option value="">—</option>
              {departmentOptions.map(option => (
                <option key={option.id} value={option.id}>
                  {'  '.repeat(option.level)}{option.name}
                </option>
              ))}
            </select>
          </label>
          {saving && progress && (
            <ProgressBar
              label={progress.failed > 0
                ? `Перенос сотрудников (ошибок: ${progress.failed})`
                : 'Перенос сотрудников'}
              current={progress.processed}
              total={progress.total}
            />
          )}
        </div>
        <div className="ep-modal-footer">
          <button className="ep-modal-btn secondary" onClick={() => setDialog(null)} disabled={saving}>
            Отмена
          </button>
          <button className="ep-modal-btn primary" onClick={onSave} disabled={saving}>
            {saving ? 'Перемещение...' : 'Переместить'}
          </button>
        </div>
      </div>
    </div>
  );
};
