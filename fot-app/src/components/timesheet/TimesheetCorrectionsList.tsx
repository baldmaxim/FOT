import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Trash2, Plus, Paperclip } from 'lucide-react';
import { timesheetService, type ITimesheetCorrectionRow } from '../../services/timesheetService';
import { correctionAttachmentsService } from '../../services/correctionAttachmentsService';
import type { TimesheetStatus, TimesheetEmployee } from '../../types';
import { TimesheetCorrectionModal } from './TimesheetCorrectionModal';
import { TimesheetBulkCorrectionModal } from './TimesheetBulkCorrectionModal';
import { CorrectionApprovalBadge } from './CorrectionApprovalBadge';
import { CorrectionAttachments } from './CorrectionAttachments';
import { generateDateRange } from '../../utils/calendarUtils';
import { CREATABLE_STATUS_META, getStatusMeta } from '../../utils/correctionStatus';
import { useToast } from '../../contexts/ToastContext';

interface IProps {
  startDate: string;
  endDate: string;
  departmentId: string | null;
  employees: TimesheetEmployee[];
}

const formatDate = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const formatHours = (hours: number | null): string => {
  if (hours == null) return '—';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (m === 0) return `${h} ч`;
  return `${h}:${String(m).padStart(2, '0')}`;
};

export const TimesheetCorrectionsList: FC<IProps> = ({ startDate, endDate, departmentId, employees }) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filterAuthor, setFilterAuthor] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<'' | TimesheetStatus>('');
  const [filterEmployeeId, setFilterEmployeeId] = useState<string>('');
  const [editingRow, setEditingRow] = useState<ITimesheetCorrectionRow | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  const [attachmentsOpenForId, setAttachmentsOpenForId] = useState<number | null>(null);
  const attachmentsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (attachmentsOpenForId == null) return;
    const handleClick = (e: MouseEvent) => {
      if (attachmentsRef.current && !attachmentsRef.current.contains(e.target as Node)) {
        setAttachmentsOpenForId(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAttachmentsOpenForId(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [attachmentsOpenForId]);

  const invalidateAll = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
  ]);

  const handleBulkConfirm = async (params: {
    employeeId: number;
    dateFrom: string;
    dateTo: string;
    status: TimesheetStatus;
    hours: number | null;
    notes: string;
    files?: File[];
  }) => {
    setBulkPending(true);
    try {
      const dates = generateDateRange(params.dateFrom, params.dateTo);
      const result = await timesheetService.bulkCorrect({
        items: dates.map(work_date => ({ employee_id: params.employeeId, work_date })),
        status: params.status,
        hours_worked: params.hours,
        notes: params.notes,
      });

      // Загружаем файлы для каждой созданной корректировки
      if (params.files?.length) {
        if (!result.items?.length) {
          toast.error('Файлы не прикреплены: сервер не вернул ID корректировок');
        } else {
          const uploadResults = await Promise.allSettled(
            result.items.flatMap(item =>
              params.files!.map(file => correctionAttachmentsService.upload(item.adjustment_id, file))
            )
          );
          const failed = uploadResults.filter(r => r.status === 'rejected').length;
          if (failed > 0) {
            console.error('Bulk attachments upload error: failed uploads =', failed);
            toast.error(`Корректировка применена, но ${failed} файл(ов) не загрузилось`);
          }
        }
      }

      await invalidateAll();
      setBulkOpen(false);
    } catch (error) {
      console.error('Bulk correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось применить массовую корректировку');
    } finally {
      setBulkPending(false);
    }
  };

  const updateMutation = useMutation({
    mutationFn: (payload: { id: number; status: TimesheetStatus; hours: number | null; notes: string }) =>
      timesheetService.update(payload.id, { status: payload.status, hours_worked: payload.hours, notes: payload.notes }),
    onSuccess: async () => {
      await invalidateAll();
      setEditingRow(null);
    },
  });

  const query = useQuery({
    queryKey: ['timesheet-corrections', startDate, endDate, departmentId],
    queryFn: () => timesheetService.listCorrections({ start_date: startDate, end_date: endDate, department_id: departmentId ?? undefined }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => timesheetService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] });
      queryClient.invalidateQueries({ queryKey: ['timesheet'] });
    },
  });

  const authors = useMemo(() => {
    const set = new Map<string, string>();
    for (const row of query.data ?? []) {
      if (row.created_by && row.author_name) set.set(row.created_by, row.author_name);
    }
    return [...set.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [query.data]);

  const employeeOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of query.data ?? []) {
      map.set(row.employee_id, row.employee_full_name ?? `#${row.employee_id}`);
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [query.data]);

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const filtered = all.filter(row => {
      if (filterAuthor && row.created_by !== filterAuthor) return false;
      if (filterStatus && row.status !== filterStatus) return false;
      if (filterEmployeeId && String(row.employee_id) !== filterEmployeeId) return false;
      return true;
    });
    return filtered.sort((a, b) => a.work_date.localeCompare(b.work_date));
  }, [query.data, filterAuthor, filterStatus, filterEmployeeId]);

  const handleDelete = (row: ITimesheetCorrectionRow) => {
    if (!row.can_delete) return;
    const ok = window.confirm(`Удалить корректировку на ${formatDate(row.work_date)}?`);
    if (!ok) return;
    deleteMutation.mutate(row.id);
  };

  if (query.isLoading) {
    return <div className="ts-corrections-empty">Загрузка корректировок…</div>;
  }
  if (query.isError) {
    return <div className="ts-corrections-empty">Ошибка загрузки корректировок</div>;
  }

  return (
    <div className="ts-corrections">
      <div className="ts-corrections-filters">
        {employeeOptions.length > 1 && (
          <label className="ts-corrections-filter">
            Сотрудник:
            <select value={filterEmployeeId} onChange={(e) => setFilterEmployeeId(e.target.value)}>
              <option value="">Все</option>
              {employeeOptions.map(emp => (
                <option key={emp.id} value={String(emp.id)}>{emp.name}</option>
              ))}
            </select>
          </label>
        )}
        {authors.length > 1 && (
          <label className="ts-corrections-filter">
            Автор:
            <select value={filterAuthor} onChange={(e) => setFilterAuthor(e.target.value)}>
              <option value="">Все</option>
              {authors.map(author => (
                <option key={author.id} value={author.id}>{author.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="ts-corrections-filter">
          Статус:
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as '' | TimesheetStatus)}>
            <option value="">Все</option>
            {CREATABLE_STATUS_META.map(meta => (
              <option key={meta.status} value={meta.status}>{meta.icon} {meta.label}</option>
            ))}
          </select>
        </label>
        <div className="ts-corrections-count">Всего: {rows.length}</div>
        <button
          type="button"
          className="ts-corrections-add-btn"
          onClick={() => setBulkOpen(true)}
          disabled={employees.length === 0}
          title={employees.length === 0 ? 'Нет сотрудников для корректировки' : 'Создать корректировку на диапазон дат'}
        >
          <Plus size={14} />
          Добавить
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="ts-corrections-empty">Нет корректировок за выбранный период</div>
      ) : (
        <div className="ts-corrections-scroll">
          <table className="ts-corrections-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Сотрудник</th>
                <th>Статус</th>
                <th>Часы</th>
                <th>Автор</th>
                <th>Комментарий</th>
                <th aria-label="Согласовано"></th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className={row.approval_locked ? 'ts-corrections-row--locked' : ''}>
                  <td>{formatDate(row.work_date)}</td>
                  <td>{row.employee_full_name ?? `#${row.employee_id}`}</td>
                  <td>
                    {(() => {
                      const meta = getStatusMeta(row.status);
                      return (
                        <span className="ts-status-badge">
                          <span className="ts-status-badge__icon">{meta?.icon ?? '✎'}</span>
                          {meta?.label ?? row.status}
                        </span>
                      );
                    })()}
                  </td>
                  <td>{formatHours(row.hours_override)}</td>
                  <td>{row.author_name ?? '—'}</td>
                  <td className="ts-corrections-reason">{row.reason ?? ''}</td>
                  <td>
                    <CorrectionApprovalBadge
                      approvedAt={row.approved_at ?? null}
                      approverName={row.approver_name ?? null}
                      approvalComment={row.approval_comment ?? null}
                    />
                  </td>
                  <td className="ts-corrections-actions">
                    {row.approval_locked && (
                      <span className="ts-corrections-lock" title="Период заблокирован">
                        <Lock size={14} />
                      </span>
                    )}
                    {(row.attachments_count ?? 0) > 0 || row.can_edit ? (
                      <span className="ts-corrections-attach-cell">
                        <button
                          type="button"
                          className="ts-corrections-btn ts-corrections-attach-btn"
                          onClick={() => setAttachmentsOpenForId(
                            attachmentsOpenForId === row.id ? null : row.id,
                          )}
                          title="Приложенные файлы"
                          aria-label="Приложенные файлы"
                        >
                          <Paperclip size={14} />
                          {(row.attachments_count ?? 0) > 0 && (
                            <span className="ts-corrections-attach-btn__count">{row.attachments_count}</span>
                          )}
                        </button>
                        {attachmentsOpenForId === row.id && (
                          <div ref={attachmentsRef} className="ts-corrections-attach-popover">
                            <CorrectionAttachments
                              adjustmentId={row.id}
                              variant="popover"
                              canEdit={false}
                            />
                          </div>
                        )}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="ts-corrections-btn"
                      disabled={!row.can_edit}
                      onClick={() => setEditingRow(row)}
                      title={
                        row.can_edit ? 'Редактировать'
                          : row.month_out_of_range ? 'Период старше прошлого месяца — обратитесь к администратору'
                            : row.approval_locked ? 'Период подан, доступ закрыт'
                              : 'Нет прав на редактирование'
                      }
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="ts-corrections-btn ts-corrections-btn--danger"
                      disabled={!row.can_delete || deleteMutation.isPending}
                      onClick={() => handleDelete(row)}
                      title={
                        row.can_delete ? 'Удалить'
                          : row.month_out_of_range ? 'Период старше прошлого месяца — обратитесь к администратору'
                            : row.approval_locked ? 'Период подан, доступ закрыт'
                              : 'Нет прав на удаление'
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TimesheetBulkCorrectionModal
        open={bulkOpen}
        employees={employees}
        pending={bulkPending}
        onClose={() => setBulkOpen(false)}
        onConfirm={handleBulkConfirm}
      />

      {editingRow && (
        <TimesheetCorrectionModal
          open={true}
          title="Редактирование корректировки"
          subtitle={formatDate(editingRow.work_date)}
          dayLabel={formatDate(editingRow.work_date)}
          employeeName={editingRow.employee_full_name ?? `#${editingRow.employee_id}`}
          employeeId={editingRow.employee_id}
          workDate={editingRow.work_date}
          initialStatus={editingRow.status}
          initialHours={editingRow.hours_override}
          initialNotes={editingRow.reason ?? ''}
          initialMode="edit"
          correctionInfo={{
            is_correction: true,
            corrected_at: editingRow.updated_at,
            corrected_by_name: editingRow.author_name,
            approved_at: editingRow.approved_at ?? null,
            approved_by_name: editingRow.approver_name ?? null,
            approval_comment: editingRow.approval_comment ?? null,
            adjustment_id: editingRow.id,
          }}
          onClose={() => setEditingRow(null)}
          onSave={(status, hours, notes) => {
            if (!editingRow) return;
            updateMutation.mutate({ id: editingRow.id, status, hours, notes });
          }}
          onDelete={editingRow.can_delete ? () => {
            if (!editingRow) return;
            const ok = window.confirm(`Удалить корректировку на ${formatDate(editingRow.work_date)}?`);
            if (!ok) return;
            deleteMutation.mutate(editingRow.id, {
              onSuccess: () => setEditingRow(null),
            });
          } : undefined}
        />
      )}
    </div>
  );
};
