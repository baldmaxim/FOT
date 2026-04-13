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
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 8px',
      border: '1px solid var(--border)',
      borderRadius: 9,
      background: 'var(--bg-secondary)',
      flexWrap: 'wrap',
      minWidth: 190,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <strong style={{ fontSize: 12, lineHeight: 1.2 }}>{formatTimesheetHalfLabel(half, year, monthNumber)}</strong>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: STATUS_COLORS[status], fontSize: 11, fontWeight: 500, lineHeight: 1.2 }}>
          <Icon size={14} /> {APPROVAL_STATUS_LABELS[status]}
        </span>
        {approval?.review_comment && (
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.3 }}>
            {approval.review_comment}
          </span>
        )}
      </div>

      {canSubmitDepartment && (status === 'draft' || status === 'rejected' || status === 'returned') && (
        <button
          className="ts-btn"
          onClick={onSubmit}
          disabled={loading}
          style={{ marginLeft: 'auto' }}
        >
          <Send size={14} /> {submitLabel}
        </button>
      )}

      {canReviewHr && status === 'submitted' && (
        <>
          {showComment ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
              <input
                style={{
                  padding: '5px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                }}
                placeholder="Комментарий..."
                value={comment}
                onChange={e => onCommentChange(e.target.value)}
              />
              <button className="ts-btn" onClick={onApprove} disabled={loading} style={{ background: '#22c55e', color: 'white' }}>
                <Check size={14} /> Утвердить
              </button>
              <button className="ts-btn" onClick={onReject} disabled={loading} style={{ background: '#ef4444', color: 'white' }}>
                <X size={14} /> Отклонить
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <button className="ts-btn" onClick={onApprove} disabled={loading} style={{ background: '#22c55e', color: 'white' }}>
                <Check size={14} /> Утвердить
              </button>
              <button className="ts-btn" onClick={() => setShowComment(true)} disabled={loading} style={{ background: '#ef4444', color: 'white' }}>
                <X size={14} /> Отклонить
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export const TimesheetApprovalBar: FC<IProps> = ({ departmentId, month }) => {
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.2, whiteSpace: 'nowrap' }}>Согласование табеля</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {(['H1', 'H2'] as TimesheetApprovalHalf[]).map(half => (
          <PeriodCard
            key={half}
            approval={approvalsByHalf[half]}
            canSubmitDepartment={canSubmitDepartment}
            canReviewHr={canReviewHr}
            comment={comments[half]}
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
