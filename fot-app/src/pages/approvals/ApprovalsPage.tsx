import { type FC, useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, RotateCcw, ChevronDown, ChevronUp, FileText, AlertTriangle } from 'lucide-react';
import {
  timesheetApprovalService,
  APPROVAL_STATUS_LABELS,
  type TimesheetApprovalStatus,
  type IApprovalReviewItem,
} from '../../services/timesheetApprovalService';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import './ApprovalsPage.css';

const STATUS_TABS: Array<{ code: TimesheetApprovalStatus; label: string }> = [
  { code: 'submitted', label: 'На проверке' },
  { code: 'approved', label: 'Утверждённые' },
  { code: 'rejected', label: 'Отклонённые / на доработке' },
];

const formatDate = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const severity = (row: IApprovalReviewItem): 'red' | 'yellow' | 'green' => {
  if (row.problem_flags.weekend_work_without_attachment || row.problem_flags.correction_exceeds_skud) return 'red';
  if (row.problem_flags.any_correction || row.problem_flags.absent_days) return 'yellow';
  return 'green';
};

export const ApprovalsPage: FC = () => {
  const { hasPermission } = useAuth();
  const canReview = hasPermission('timesheet.workflow.review');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [status, setStatus] = useState<TimesheetApprovalStatus>('submitted');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const query = useQuery({
    queryKey: ['approvals-review-list', status],
    queryFn: () => timesheetApprovalService.getReviewList(status),
  });

  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['approvals-review-list'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] }),
  ]);

  const approveMutation = useMutation({
    mutationFn: (id: number) => timesheetApprovalService.approve(id),
    onSuccess: async () => {
      await invalidate();
      toast.success?.('Табель утверждён');
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка утверждения'),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) => timesheetApprovalService.reject(id, comment),
    onSuccess: async () => {
      await invalidate();
      toast.success?.('Табель отклонён');
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка отклонения'),
  });

  const returnMutation = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) => timesheetApprovalService.returnToRework(id, comment),
    onSuccess: async () => {
      await invalidate();
      toast.success?.('Возвращено на доработку');
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка возврата'),
  });

  const rows: IApprovalReviewItem[] = useMemo(() => query.data ?? [], [query.data]);

  const handleReject = (row: IApprovalReviewItem) => {
    const comment = window.prompt('Комментарий (причина отклонения):', '') ?? '';
    if (!comment.trim()) return;
    rejectMutation.mutate({ id: row.id, comment });
  };

  const handleReturn = (row: IApprovalReviewItem) => {
    const comment = window.prompt('Комментарий (причина возврата):', '') ?? '';
    if (!comment.trim()) return;
    returnMutation.mutate({ id: row.id, comment });
  };

  return (
    <div className="approvals-page">
      <header className="approvals-header">
        <h1>Согласования</h1>
        <p className="approvals-subtitle">Проверка поданных табелей и подтверждений работы в выходные</p>
      </header>

      <div className="approvals-tabs">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.code}
            type="button"
            className={`approvals-tab${status === tab.code ? ' approvals-tab--active' : ''}`}
            onClick={() => setStatus(tab.code)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <div className="approvals-empty">Загрузка…</div>
      ) : query.isError ? (
        <div className="approvals-empty">Ошибка загрузки</div>
      ) : rows.length === 0 ? (
        <div className="approvals-empty">Нет подач в этом статусе</div>
      ) : (
        <ul className="approvals-list">
          {rows.map(row => {
            const sev = severity(row);
            const expanded = expandedId === row.id;
            return (
              <li key={row.id} className={`approvals-card approvals-card--${sev}`}>
                <button
                  type="button"
                  className="approvals-card-header"
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                >
                  <span className="approvals-card-badge" aria-label={`Серьёзность: ${sev}`} />
                  <div className="approvals-card-info">
                    <strong>{row.department_name ?? row.department_id}</strong>
                    <span className="approvals-card-range">{formatDate(row.start_date)} — {formatDate(row.end_date)}</span>
                  </div>
                  <span className="approvals-card-status">{APPROVAL_STATUS_LABELS[row.status]}</span>
                  <span className="approvals-card-submitted">
                    {row.submitted_by_name ?? '—'}{row.submitted_at ? `, ${formatDate(row.submitted_at.slice(0, 10))}` : ''}
                  </span>
                  {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {expanded && (
                  <div className="approvals-card-body">
                    <div className="approvals-flags">
                      {row.problem_flags.weekend_work_without_attachment && (
                        <span className="approvals-flag approvals-flag--red">
                          <AlertTriangle size={12} /> Работа в выходной без вложений
                        </span>
                      )}
                      {row.problem_flags.correction_exceeds_skud && (
                        <span className="approvals-flag approvals-flag--red">
                          <AlertTriangle size={12} /> Корректировка &gt; факта СКУД
                        </span>
                      )}
                      {row.problem_flags.any_correction && (
                        <span className="approvals-flag approvals-flag--yellow">
                          Корректировки руководителя
                        </span>
                      )}
                      {row.problem_flags.absent_days && (
                        <span className="approvals-flag approvals-flag--yellow">
                          Есть отсутствия
                        </span>
                      )}
                      {row.weekend_work_dates.length > 0 && (
                        <span className="approvals-flag approvals-flag--info">
                          Выходные с работой: {row.weekend_work_dates.join(', ')}
                        </span>
                      )}
                    </div>

                    {row.attachments_count > 0 && (
                      <div className="approvals-attachments">
                        <FileText size={14} />
                        Вложений: {row.attachments_count}
                      </div>
                    )}

                    {row.review_comment && (
                      <div className="approvals-comment">Комментарий: {row.review_comment}</div>
                    )}

                    {canReview && (
                      <div className="approvals-actions">
                        {row.status === 'submitted' && (
                          <>
                            <button
                              type="button"
                              className="ts-btn ts-btn--success"
                              onClick={() => approveMutation.mutate(row.id)}
                              disabled={approveMutation.isPending}
                            >
                              <Check size={14} /> Утвердить
                            </button>
                            <button
                              type="button"
                              className="ts-btn ts-btn--danger"
                              onClick={() => handleReject(row)}
                              disabled={rejectMutation.isPending}
                            >
                              <X size={14} /> Отклонить
                            </button>
                          </>
                        )}
                        {row.status === 'approved' && (
                          <button
                            type="button"
                            className="ts-btn"
                            onClick={() => handleReturn(row)}
                            disabled={returnMutation.isPending}
                          >
                            <RotateCcw size={14} /> Вернуть на доработку
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
