import { type FC, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, Send, Clock, CheckCircle, XCircle, RotateCcw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  timesheetApprovalService,
  APPROVAL_STATUS_LABELS,
  type ITimesheetApproval,
  type TimesheetApprovalStatus,
} from '../../services/timesheetApprovalService';
import { useTimesheetApprovalStatuses } from '../../hooks/useTimesheetApprovalData';
import { buildTimesheetApprovalPeriod, formatTimesheetHalfLabel, type TimesheetApprovalHalf } from '../../utils/timesheetApprovalPeriod';

interface IProps {
  departmentId: string | null;
  month: string; // YYYY-MM
  compact?: boolean;
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

interface IPeriodCardProps {
  approval: ITimesheetApproval | null;
  canSubmitDepartment: boolean;
  canReviewHr: boolean;
  comment: string;
  compact: boolean;
  half: TimesheetApprovalHalf;
  loading: boolean;
  month: string;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  onSubmit: () => Promise<void>;
  onCommentChange: (value: string) => void;
}

const PeriodCard: FC<IPeriodCardProps> = ({
  approval,
  canSubmitDepartment,
  canReviewHr,
  comment,
  compact,
  half,
  loading,
  month,
  onApprove,
  onReject,
  onSubmit,
  onCommentChange,
}) => {
  const status = approval?.status || 'draft';
  const Icon = STATUS_ICONS[status];
  const [showComment, setShowComment] = useState(false);
  const [year, monthNumber] = month.split('-').map(Number);
  const submitLabel = status === 'returned' || status === 'rejected' ? 'Переподать' : 'Подать';

  return (
    <div className={`ts-approval-card${compact ? ' ts-approval-card--compact' : ''}`}>
      <div className="ts-approval-card-info">
        <strong className="ts-approval-period">
          {formatTimesheetHalfLabel(half, year, monthNumber)}
        </strong>
        <span
          className="ts-approval-status"
          style={{ color: STATUS_COLORS[status] }}
        >
          <Icon size={14} /> {APPROVAL_STATUS_LABELS[status]}
        </span>
        {approval?.review_comment && (
          <span className="ts-approval-comment-preview">
            {approval.review_comment}
          </span>
        )}
      </div>

      {canSubmitDepartment && (status === 'draft' || status === 'rejected' || status === 'returned') && (
        <button
          className="ts-btn"
          onClick={onSubmit}
          disabled={loading}
          type="button"
        >
          <Send size={14} /> {submitLabel}
        </button>
      )}

      {canReviewHr && status === 'submitted' && (
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

export const TimesheetApprovalBar: FC<IProps> = ({ departmentId, month, compact = false }) => {
  const { canEditPage } = useAuth();
  const canSubmitDepartment = canEditPage('/timesheet');
  const canReviewHr = canEditPage('/timesheet-hr');
  const queryClient = useQueryClient();
  const { data: approvalsByHalf } = useTimesheetApprovalStatuses(departmentId, month);
  const [loadingHalf, setLoadingHalf] = useState<TimesheetApprovalHalf | null>(null);
  const [comments, setComments] = useState<Record<TimesheetApprovalHalf, string>>({ H1: '', H2: '' });

  const runAction = async (half: TimesheetApprovalHalf, action: () => Promise<void>) => {
    setLoadingHalf(half);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] });
    } finally {
      setLoadingHalf(null);
    }
  };

  const handleSubmit = async (half: TimesheetApprovalHalf) => {
    if (!departmentId) return;
    const period = buildTimesheetApprovalPeriod(month, half);
    await runAction(half, async () => {
      await timesheetApprovalService.submit(departmentId, period);
    });
  };

  const handleApprove = async (half: TimesheetApprovalHalf) => {
    const approval = approvalsByHalf[half];
    if (!approval) return;
    await runAction(half, async () => {
      await timesheetApprovalService.approve(approval.id, comments[half] || undefined);
      setComments(prev => ({ ...prev, [half]: '' }));
    });
  };

  const handleReject = async (half: TimesheetApprovalHalf) => {
    const approval = approvalsByHalf[half];
    if (!approval) return;
    await runAction(half, async () => {
      await timesheetApprovalService.reject(approval.id, comments[half] || undefined);
      setComments(prev => ({ ...prev, [half]: '' }));
    });
  };

  return (
    <div className={`ts-approval-bar${compact ? ' ts-approval-bar--compact' : ''}`}>
      <div className="ts-approval-title">
        {compact ? 'Периоды согласования' : 'Согласование табеля'}
      </div>
      <div className="ts-approval-list">
        {(['H1', 'H2'] as TimesheetApprovalHalf[]).map(half => (
          <PeriodCard
            key={half}
            approval={approvalsByHalf[half]}
            canSubmitDepartment={canSubmitDepartment}
            canReviewHr={canReviewHr}
            comment={comments[half]}
            compact={compact}
            half={half}
            loading={loadingHalf === half}
            month={month}
            onApprove={() => handleApprove(half)}
            onReject={() => handleReject(half)}
            onSubmit={() => handleSubmit(half)}
            onCommentChange={value => setComments(prev => ({ ...prev, [half]: value }))}
          />
        ))}
      </div>
    </div>
  );
};
