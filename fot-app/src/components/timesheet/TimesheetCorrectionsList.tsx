import { type FC, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Trash2 } from 'lucide-react';
import { timesheetService, type ITimesheetCorrectionRow } from '../../services/timesheetService';
import type { TimesheetStatus } from '../../types';

interface IProps {
  startDate: string;
  endDate: string;
  departmentId: string | null;
  onEdit: (row: ITimesheetCorrectionRow) => void;
}

const STATUS_LABELS: Record<TimesheetStatus, string> = {
  work: 'Работа',
  vacation: 'Отпуск',
  dayoff: 'Отгул',
  remote: 'Удалёнка',
  unpaid: 'Без оплаты',
  absent: 'Отсутствие',
  sick: 'Больничный',
  business_trip: 'Командировка',
  manual: 'Ручная',
};

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

export const TimesheetCorrectionsList: FC<IProps> = ({ startDate, endDate, departmentId, onEdit }) => {
  const queryClient = useQueryClient();
  const [filterAuthor, setFilterAuthor] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<'' | TimesheetStatus>('');

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

  const rows = useMemo(() => {
    const all = query.data ?? [];
    return all.filter(row => {
      if (filterAuthor && row.created_by !== filterAuthor) return false;
      if (filterStatus && row.status !== filterStatus) return false;
      return true;
    });
  }, [query.data, filterAuthor, filterStatus]);

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
            {Object.entries(STATUS_LABELS).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </label>
        <div className="ts-corrections-count">Всего: {rows.length}</div>
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
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className={row.approval_locked ? 'ts-corrections-row--locked' : ''}>
                  <td>{formatDate(row.work_date)}</td>
                  <td>{row.employee_full_name ?? `#${row.employee_id}`}</td>
                  <td>{STATUS_LABELS[row.status] ?? row.status}</td>
                  <td>{formatHours(row.hours_override)}</td>
                  <td>{row.author_name ?? '—'}</td>
                  <td className="ts-corrections-reason">{row.reason ?? ''}</td>
                  <td className="ts-corrections-actions">
                    {row.approval_locked && (
                      <span className="ts-corrections-lock" title="Период заблокирован">
                        <Lock size={14} />
                      </span>
                    )}
                    <button
                      type="button"
                      className="ts-corrections-btn"
                      disabled={!row.can_edit}
                      onClick={() => onEdit(row)}
                      title={row.can_edit ? 'Редактировать' : 'Нет прав на редактирование'}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="ts-corrections-btn ts-corrections-btn--danger"
                      disabled={!row.can_delete || deleteMutation.isPending}
                      onClick={() => handleDelete(row)}
                      title={row.can_delete ? 'Удалить' : 'Нет прав на удаление'}
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
    </div>
  );
};
