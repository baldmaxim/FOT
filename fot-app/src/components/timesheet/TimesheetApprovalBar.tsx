import { type FC, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, Send, Clock, CheckCircle, XCircle, RotateCcw, AlertCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  timesheetApprovalService,
  APPROVAL_STATUS_LABELS,
  type ITimesheetApproval,
  type TimesheetApprovalStatus,
} from '../../services/timesheetApprovalService';
import { ApiError } from '../../api/client';
import { useTimesheetApprovalStatus, useTimesheetDepartmentApprovals } from '../../hooks/useTimesheetApprovalData';
import { formatTimesheetRangeLabel } from '../../utils/timesheetApprovalPeriod';

interface IProps {
  departmentId: string | null;
  month: string; // YYYY-MM (для списка всех согласований месяца)
  startDate: string;
  endDate: string;
  compact?: boolean;
  allowReview?: boolean;
}

interface IMissingDay {
  date: string;
  employee_id: number;
  employee_name: string | null;
  kind: 'pending_correction' | 'leave_request' | 'weekend_no_correction';
  reason: string;
}

const STATUS_COLORS: Record<TimesheetApprovalStatus, string> = {
  draft: '#6b7280',
  submitted: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  returned: '#f59e0b',
};

const STATUS_ICONS: Record<TimesheetApprovalStatus, FC<{ size?: number }>> = {
  draft: Clock,
  submitted: Clock,
  approved: CheckCircle,
  rejected: XCircle,
  returned: RotateCcw,
};

const formatDayLabel = (iso: string): string => {
  const [, m, d] = iso.split('-');
  return `${Number(d)}.${m}`;
};

interface IActiveCardProps {
  approval: ITimesheetApproval | null;
  canSubmitDepartment: boolean;
  canReviewApproval: boolean;
  comment: string;
  compact: boolean;
  startDate: string;
  endDate: string;
  loading: boolean;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  onSubmit: () => Promise<void>;
  onCommentChange: (value: string) => void;
}

const ActiveCard: FC<IActiveCardProps> = ({
  approval,
  canSubmitDepartment,
  canReviewApproval,
  comment,
  compact,
  startDate,
  endDate,
  loading,
  onApprove,
  onReject,
  onSubmit,
  onCommentChange,
}) => {
  const status = approval?.status || 'draft';
  const Icon = STATUS_ICONS[status];
  const [showComment, setShowComment] = useState(false);
  const submitLabel = status === 'returned' || status === 'rejected' ? 'Переподать' : 'Подать';

  return (
    <div className={`ts-approval-card${compact ? ' ts-approval-card--compact' : ''}`}>
      <div className="ts-approval-card-info">
        <strong className="ts-approval-period">
          {formatTimesheetRangeLabel(startDate, endDate)}
        </strong>
        <span className="ts-approval-status" style={{ color: STATUS_COLORS[status] }}>
          <Icon size={14} /> {APPROVAL_STATUS_LABELS[status]}
        </span>
        {approval?.review_comment && (
          <span className="ts-approval-comment-preview">{approval.review_comment}</span>
        )}
      </div>

      {canSubmitDepartment && (status === 'draft' || status === 'rejected' || status === 'returned') && (
        <button className="ts-btn" onClick={onSubmit} disabled={loading} type="button">
          <Send size={14} /> {submitLabel}
        </button>
      )}

      {canReviewApproval && status === 'submitted' && (
        <>
          {showComment ? (
            <div className="ts-approval-actions">
              <input
                className="ts-approval-input"
                placeholder="Комментарий..."
                value={comment}
                onChange={e => onCommentChange(e.target.value)}
              />
              <button className="ts-btn ts-btn--success" onClick={onApprove} disabled={loading} type="button">
                <Check size={14} /> Утвердить
              </button>
              <button className="ts-btn ts-btn--danger" onClick={onReject} disabled={loading} type="button">
                <X size={14} /> Отклонить
              </button>
            </div>
          ) : (
            <div className="ts-approval-actions">
              <button className="ts-btn ts-btn--success" onClick={onApprove} disabled={loading} type="button">
                <Check size={14} /> Утвердить
              </button>
              <button
                className="ts-btn ts-btn--danger"
                onClick={() => setShowComment(true)}
                disabled={loading}
                type="button"
              >
                <X size={14} /> Отклонить
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export const TimesheetApprovalBar: FC<IProps> = ({
  departmentId,
  month,
  startDate,
  endDate,
  compact = false,
  allowReview = true,
}) => {
  const { hasPermission } = useAuth();
  const canSubmitDepartment = hasPermission('timesheet.workflow.submit');
  const canReviewApproval = allowReview && hasPermission('timesheet.workflow.review');
  const queryClient = useQueryClient();
  const activeStatus = useTimesheetApprovalStatus(departmentId, startDate, endDate);
  const monthApprovals = useTimesheetDepartmentApprovals(departmentId, month);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [missingDays, setMissingDays] = useState<IMissingDay[]>([]);

  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
  ]);

  const runAction = async (action: () => Promise<void>) => {
    setLoading(true);
    try {
      await action();
      await invalidate();
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!departmentId) return;
    setSubmitError(null);
    setMissingDays([]);
    setLoading(true);
    try {
      await timesheetApprovalService.submit(departmentId, startDate, endDate);
      await invalidate();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CORRECTION_VALIDATION_FAILED') {
        const days = (err.details?.missing_days as IMissingDay[] | undefined) ?? [];
        setMissingDays(days);
        setSubmitError(err.message);
      } else {
        const message = err instanceof Error ? err.message : 'Ошибка подачи табеля';
        setSubmitError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    const approval = activeStatus.data ?? null;
    if (!approval) return;
    await runAction(async () => {
      await timesheetApprovalService.approve(approval.id, comment || undefined);
      setComment('');
    });
  };

  const handleReject = async () => {
    const approval = activeStatus.data ?? null;
    if (!approval) return;
    await runAction(async () => {
      await timesheetApprovalService.reject(approval.id, comment || undefined);
      setComment('');
    });
  };

  const otherApprovals = (monthApprovals.data ?? []).filter(approval => {
    const active = activeStatus.data;
    if (!active) return true;
    return approval.id !== active.id;
  });

  const dismissMissing = () => {
    setMissingDays([]);
    setSubmitError(null);
  };

  return (
    <div className={`ts-approval-bar${compact ? ' ts-approval-bar--compact' : ''}`}>
      <div className="ts-approval-title">
        {compact ? 'Согласование диапазона' : 'Согласование табеля'}
      </div>
      <ActiveCard
        approval={activeStatus.data ?? null}
        canSubmitDepartment={canSubmitDepartment}
        canReviewApproval={canReviewApproval}
        comment={comment}
        compact={compact}
        startDate={startDate}
        endDate={endDate}
        loading={loading}
        onApprove={handleApprove}
        onReject={handleReject}
        onSubmit={handleSubmit}
        onCommentChange={setComment}
      />
      {(submitError || missingDays.length > 0) && (
        <div className="ts-approval-submit-error">
          <div className="ts-approval-submit-error-header">
            <AlertCircle size={14} />
            <span>{submitError || 'Подача невозможна'}</span>
            <button
              type="button"
              className="ts-approval-submit-error-close"
              onClick={dismissMissing}
              aria-label="Скрыть"
            >
              <X size={12} />
            </button>
          </div>
          {missingDays.length > 0 && (
            <ul className="ts-approval-submit-error-list">
              {missingDays.map((day, idx) => (
                <li key={`${day.employee_id}-${day.date}-${day.kind}-${idx}`}>
                  <strong>{formatDayLabel(day.date)}</strong>
                  {day.employee_name ? <span> • {day.employee_name}</span> : null}
                  <span className="ts-approval-submit-error-reason"> — {day.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {otherApprovals.length > 0 && (
        <div className="ts-approval-other-list">
          <div className="ts-approval-other-title">Другие согласования за месяц:</div>
          <ul className="ts-approval-other-items">
            {otherApprovals.map(approval => {
              const Icon = STATUS_ICONS[approval.status];
              return (
                <li key={approval.id} className="ts-approval-other-item">
                  <span className="ts-approval-other-range">
                    {formatTimesheetRangeLabel(approval.start_date, approval.end_date)}
                  </span>
                  <span className="ts-approval-other-status" style={{ color: STATUS_COLORS[approval.status] }}>
                    <Icon size={12} /> {APPROVAL_STATUS_LABELS[approval.status]}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};
