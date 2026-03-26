import { type FC, useState, useEffect, useCallback } from 'react';
import { Check, X, Send, Clock, CheckCircle, XCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  timesheetApprovalService,
  APPROVAL_STATUS_LABELS,
  type ITimesheetApproval,
  type TimesheetApprovalStatus,
} from '../../services/timesheetApprovalService';

interface IProps {
  departmentId: string | null;
  period: string; // YYYY-MM
}

const STATUS_COLORS: Record<TimesheetApprovalStatus, string> = {
  draft: '#6b7280',
  submitted: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
};

const STATUS_ICONS: Record<TimesheetApprovalStatus, FC<{ size?: number }>> = {
  draft: Clock,
  submitted: Clock,
  approved: CheckCircle,
  rejected: XCircle,
};

export const TimesheetApprovalBar: FC<IProps> = ({ departmentId, period }) => {
  const { positionType } = useAuth();
  const isHeader = positionType === 'header';
  const isHrPlus = positionType === 'hr' || positionType === 'admin' || positionType === 'super_admin';

  const [approval, setApproval] = useState<ITimesheetApproval | null>(null);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [showComment, setShowComment] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!departmentId || !period) return;
    try {
      const data = await timesheetApprovalService.getStatus(departmentId, period);
      setApproval(data);
    } catch {
      setApproval(null);
    }
  }, [departmentId, period]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const status = approval?.status || 'draft';
  const Icon = STATUS_ICONS[status];

  const handleSubmit = async () => {
    if (!departmentId) return;
    setLoading(true);
    try {
      await timesheetApprovalService.submit(departmentId, period);
      await loadStatus();
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!approval) return;
    setLoading(true);
    try {
      await timesheetApprovalService.approve(approval.id, comment || undefined);
      setComment('');
      setShowComment(false);
      await loadStatus();
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    if (!approval) return;
    setLoading(true);
    try {
      await timesheetApprovalService.reject(approval.id, comment || undefined);
      setComment('');
      setShowComment(false);
      await loadStatus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0',
      flexWrap: 'wrap',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: STATUS_COLORS[status], fontSize: 13, fontWeight: 500 }}>
        <Icon size={16} /> {APPROVAL_STATUS_LABELS[status]}
      </span>

      {approval?.review_comment && (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          {approval.review_comment}
        </span>
      )}

      {isHeader && (status === 'draft' || status === 'rejected') && (
        <button
          className="ts-btn"
          onClick={handleSubmit}
          disabled={loading}
          style={{ marginLeft: 'auto' }}
        >
          <Send size={14} /> Подтвердить табель
        </button>
      )}

      {isHrPlus && status === 'submitted' && (
        <>
          {showComment ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
              <input
                style={{
                  padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13,
                }}
                placeholder="Комментарий..."
                value={comment}
                onChange={e => setComment(e.target.value)}
              />
              <button className="ts-btn" onClick={handleApprove} disabled={loading} style={{ background: '#22c55e', color: 'white' }}>
                <Check size={14} /> Утвердить
              </button>
              <button className="ts-btn" onClick={handleReject} disabled={loading} style={{ background: '#ef4444', color: 'white' }}>
                <X size={14} /> Отклонить
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <button className="ts-btn" onClick={handleApprove} disabled={loading} style={{ background: '#22c55e', color: 'white' }}>
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
