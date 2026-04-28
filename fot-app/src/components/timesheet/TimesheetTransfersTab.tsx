import { type FC, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Check, Loader2, Pencil, Trash2, UserMinus } from 'lucide-react';
import {
  timesheetService,
  type IDepartmentExclusionRow,
  type IDepartmentTransferRow,
} from '../../services/timesheetService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';

interface ITimesheetTransfersTabProps {
  departmentId: string | null;
  departmentName: string;
}

const formatDateLabel = (iso: string | null): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}.${m}.${y}`;
};

export const TimesheetTransfersTab: FC<ITimesheetTransfersTabProps> = ({
  departmentId,
  departmentName,
}) => {
  const queryClient = useQueryClient();
  const { managedDepartments } = useManagedDepartments();

  const [editingTransferId, setEditingTransferId] = useState<string | null>(null);
  const [editingExclusionEmployeeId, setEditingExclusionEmployeeId] = useState<number | null>(null);
  const [draftDate, setDraftDate] = useState<string>('');
  const [draftToDeptId, setDraftToDeptId] = useState<string>('');
  const [draftFromDeptId, setDraftFromDeptId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const listingQuery = useQuery({
    queryKey: ['timesheet-transfers', departmentId],
    queryFn: () => timesheetService.listDepartmentTransfers(departmentId!),
    enabled: !!departmentId,
    staleTime: 0,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['timesheet-transfers'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet-grid'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
    queryClient.invalidateQueries({ queryKey: ['structure'] });
  };

  const updateTransferMutation = useMutation({
    mutationFn: (vars: {
      assignmentId: string;
      patch: {
        effective_from?: string;
        to_department_id?: string;
        from_department_id?: string;
        assignment_old_id?: string;
      };
    }) => timesheetService.updateTransfer(vars.assignmentId, vars.patch),
    onSuccess: () => {
      setEditingTransferId(null);
      setDraftDate('');
      setDraftToDeptId('');
      setDraftFromDeptId('');
      setError(null);
      invalidateAll();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteTransferMutation = useMutation({
    mutationFn: (assignmentId: string) => timesheetService.deleteTransfer(assignmentId),
    onSuccess: () => {
      setError(null);
      invalidateAll();
    },
    onError: (err: Error) => setError(err.message),
  });

  const updateExclusionMutation = useMutation({
    mutationFn: (vars: { employeeId: number; effectiveDate: string }) =>
      timesheetService.updateExclusion(vars.employeeId, vars.effectiveDate),
    onSuccess: () => {
      setEditingExclusionEmployeeId(null);
      setDraftDate('');
      setError(null);
      invalidateAll();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteExclusionMutation = useMutation({
    mutationFn: (employeeId: number) => timesheetService.deleteExclusion(employeeId),
    onSuccess: () => {
      setError(null);
      invalidateAll();
    },
    onError: (err: Error) => setError(err.message),
  });

  const startEditTransfer = (row: IDepartmentTransferRow) => {
    setEditingTransferId(row.assignment_new_id);
    setEditingExclusionEmployeeId(null);
    setDraftDate(row.transfer_date);
    setDraftToDeptId(row.to_department_id);
    setDraftFromDeptId(departmentId || '');
    setError(null);
  };
  const startEditExclusion = (row: IDepartmentExclusionRow) => {
    setEditingExclusionEmployeeId(row.employee_id);
    setEditingTransferId(null);
    setDraftDate(row.exclusion_date || new Date().toISOString().slice(0, 10));
    setError(null);
  };
  const cancelEdit = () => {
    setEditingTransferId(null);
    setEditingExclusionEmployeeId(null);
    setDraftDate('');
    setDraftToDeptId('');
    setDraftFromDeptId('');
    setError(null);
  };

  const handleDeleteTransfer = (row: IDepartmentTransferRow) => {
    const ok = window.confirm(
      `Полностью отменить перевод сотрудника «${row.employee_full_name}» в отдел «${row.to_department_name}»? Сотрудник вернётся в исходный отдел.`,
    );
    if (!ok) return;
    deleteTransferMutation.mutate(row.assignment_new_id);
  };

  const handleDeleteExclusion = (row: IDepartmentExclusionRow) => {
    const ok = window.confirm(
      `Отменить исключение сотрудника «${row.employee_full_name}» из табеля? Он снова появится в табеле.`,
    );
    if (!ok) return;
    deleteExclusionMutation.mutate(row.employee_id);
  };

  const submitTransferEdit = (row: IDepartmentTransferRow) => {
    const patch: {
      effective_from?: string;
      to_department_id?: string;
      from_department_id?: string;
      assignment_old_id?: string;
    } = {
      assignment_old_id: row.assignment_old_id,
    };
    if (draftDate && draftDate !== row.transfer_date) patch.effective_from = draftDate;
    if (draftToDeptId && draftToDeptId !== row.to_department_id) patch.to_department_id = draftToDeptId;
    if (draftFromDeptId && draftFromDeptId !== departmentId) patch.from_department_id = draftFromDeptId;
    const hasChanges = patch.effective_from || patch.to_department_id || patch.from_department_id;
    if (!hasChanges) {
      cancelEdit();
      return;
    }
    if (patch.to_department_id && patch.from_department_id && patch.to_department_id === patch.from_department_id) {
      setError('Отдел назначения не может совпадать с исходным отделом');
      return;
    }
    updateTransferMutation.mutate({ assignmentId: row.assignment_new_id, patch });
  };

  const data = listingQuery.data;
  const transfers = data?.transfers ?? [];
  const exclusions = data?.exclusions ?? [];
  const isPending =
    updateTransferMutation.isPending
    || deleteTransferMutation.isPending
    || updateExclusionMutation.isPending
    || deleteExclusionMutation.isPending;

  const deptOptions = useMemo(
    () => managedDepartments.map(d => ({ id: d.id, name: d.name })),
    [managedDepartments],
  );

  if (!departmentId) {
    return (
      <div className="ts-transfers-tab">
        <div className="ts-transfers-empty">Выберите отдел, чтобы увидеть список переводов и исключений.</div>
      </div>
    );
  }

  return (
    <div className="ts-transfers-tab">
      <div className="ts-transfers-tab-header">
        <div className="ts-transfers-tab-title">Переводы и исключения</div>
        <div className="ts-transfers-tab-subtitle">{departmentName || 'Отдел не выбран'}</div>
      </div>

      <div className="ts-transfers-body ts-transfers-body--inline">
        {error && <div className="ts-transfers-error">{error}</div>}

        {listingQuery.isLoading ? (
          <div className="ts-transfers-empty">
            <Loader2 size={16} className="ts-transfers-spinner" /> Загрузка...
          </div>
        ) : listingQuery.isError ? (
          <div className="ts-transfers-error">Не удалось загрузить список переводов</div>
        ) : (
          <>
            <section className="ts-transfers-section">
              <div className="ts-transfers-section-title">
                <ArrowRightLeft size={14} /> Переведены ({transfers.length})
              </div>
              {transfers.length === 0 ? (
                <div className="ts-transfers-empty">Нет переведённых сотрудников</div>
              ) : (
                <ul className="ts-transfers-list">
                  {transfers.map(row => {
                    const isEditing = editingTransferId === row.assignment_new_id;
                    return (
                      <li
                        key={row.assignment_new_id}
                        className={`ts-transfers-row${isEditing ? ' ts-transfers-row--editing' : ''}${isEditing ? ' ts-transfers-row--expanded' : ''}`}
                      >
                        <div className="ts-transfers-row-main">
                          <div className="ts-transfers-row-name">{formatTimesheetEmployeeName(row.employee_full_name)}</div>
                          <div className="ts-transfers-row-meta">
                            → {row.to_department_name || '—'}
                          </div>
                        </div>
                        <div className="ts-transfers-row-date">
                          <span>{formatDateLabel(row.transfer_date)}</span>
                        </div>
                        <div className="ts-transfers-row-actions">
                          {isEditing ? null : (
                            <>
                              <button
                                type="button"
                                className="ts-btn ts-btn--icon"
                                title="Изменить дату или отдел"
                                disabled={isPending}
                                onClick={() => startEditTransfer(row)}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="ts-btn ts-btn--icon ts-btn--danger"
                                title="Полностью отменить перевод"
                                disabled={isPending}
                                onClick={() => handleDeleteTransfer(row)}
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
                                onClick={() => submitTransferEdit(row)}
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
              )}
            </section>

            <section className="ts-transfers-section">
              <div className="ts-transfers-section-title">
                <UserMinus size={14} /> Исключены ({exclusions.length})
              </div>
              {exclusions.length === 0 ? (
                <div className="ts-transfers-empty">Нет исключённых сотрудников</div>
              ) : (
                <ul className="ts-transfers-list">
                  {exclusions.map(row => {
                    const isEditing = editingExclusionEmployeeId === row.employee_id;
                    return (
                      <li key={row.employee_id} className={`ts-transfers-row${isEditing ? ' ts-transfers-row--editing' : ''}`}>
                        <div className="ts-transfers-row-main">
                          <div className="ts-transfers-row-name">{formatTimesheetEmployeeName(row.employee_full_name)}</div>
                          <div className="ts-transfers-row-meta">Исключён из табеля</div>
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
                                onClick={() => updateExclusionMutation.mutate({ employeeId: row.employee_id, effectiveDate: draftDate })}
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
                                onClick={() => startEditExclusion(row)}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="ts-btn ts-btn--icon ts-btn--danger"
                                title="Отменить исключение (вернуть в табель)"
                                disabled={isPending}
                                onClick={() => handleDeleteExclusion(row)}
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
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
};
