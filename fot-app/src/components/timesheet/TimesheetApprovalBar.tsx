import { type FC, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Check, X, Send, RotateCcw, AlertCircle,
  Upload, FileText, ChevronDown,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  timesheetApprovalService,
  APPROVAL_STATUS_LABELS,
  type ITimesheetApproval,
  type TimesheetSubmissionMode,
} from '../../services/timesheetApprovalService';
import { ApiError } from '../../api/client';
import { useTimesheetApprovalStatus } from '../../hooks/useTimesheetApprovalData';
import {
  formatTimesheetRangeLabel,
  getAllowedSubmissionHalf,
  getHalfRange,
  isAllowedSubmissionRange,
} from '../../utils/timesheetApprovalPeriod';
import {
  TimesheetSubmitConfirmModal,
  type ISubmitProblemEmployee,
} from './TimesheetSubmitConfirmModal';
import { STATUS_COLORS, STATUS_ICONS } from './timesheetApprovalStatus';

const MANAGER_OBJ_ROLE_CODE = 'manager_obj';

interface IProps {
  /**
   * Режим подачи:
   *  - 'department' — обычная подача отдела (требуется departmentId);
   *  - 'personal'   — персональная подача руководителя «по людям» (departmentId игнорируется,
   *                   бэк определяет автора и состав через employee_id).
   */
  submissionMode: TimesheetSubmissionMode;
  departmentId: string | null;
  startDate: string;
  endDate: string;
  compact?: boolean;
  allowReview?: boolean;
  submitProblems?: ISubmitProblemEmployee[];
}

interface IMissingDay {
  date: string;
  employee_id: number;
  employee_name: string | null;
  kind: 'leave_request' | 'weekend_no_correction';
  reason: string;
}

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
  periodSubmittable: boolean;
  submitDisabledReason: string;
  showMemoToggle: boolean;
  memoOpen: boolean;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  onSubmit: () => void;
  onRecall: () => void;
  onToggleMemo: () => void;
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
  periodSubmittable,
  submitDisabledReason,
  showMemoToggle,
  memoOpen,
  onApprove,
  onReject,
  onSubmit,
  onRecall,
  onToggleMemo,
  onCommentChange,
}) => {
  const status = approval?.status || 'draft';
  const Icon = STATUS_ICONS[status];
  const [showComment, setShowComment] = useState(false);
  const submitLabel = status === 'returned' || status === 'rejected' ? 'Переподать' : 'Подать';
  const canShowSubmit = canSubmitDepartment && (status === 'draft' || status === 'rejected' || status === 'returned');

  return (
    <div className={`ts-approval-card${compact ? ' ts-approval-card--compact' : ''}`}>
      {(compact || approval?.review_comment) && (
        <div className="ts-approval-card-info">
          {compact && (
            <>
              <strong className="ts-approval-period">
                {formatTimesheetRangeLabel(startDate, endDate)}
              </strong>
              <span className="ts-approval-status" style={{ color: STATUS_COLORS[status] }}>
                <Icon size={14} /> {APPROVAL_STATUS_LABELS[status]}
              </span>
            </>
          )}
          {approval?.review_comment && (
            <span className="ts-approval-comment-preview">{approval.review_comment}</span>
          )}
        </div>
      )}

      {canShowSubmit && (
        <div className="ts-btn-split">
          <button
            className="ts-btn ts-btn-split-main"
            onClick={onSubmit}
            disabled={loading}
            type="button"
            title={periodSubmittable ? undefined : submitDisabledReason}
          >
            <Send size={14} /> {submitLabel}
          </button>
          {showMemoToggle && (
            <button
              className={`ts-btn ts-btn-split-toggle${memoOpen ? ' ts-btn-split-toggle--open' : ''}`}
              onClick={onToggleMemo}
              type="button"
              aria-label="Открыть служебную записку о работе в выходные"
              aria-expanded={memoOpen}
              title="Служебная записка о работе в выходные"
            >
              <ChevronDown size={14} />
            </button>
          )}
        </div>
      )}

      {canSubmitDepartment && status === 'submitted' && (
        <button
          className="ts-btn"
          onClick={onRecall}
          disabled={loading}
          type="button"
          title="Отозвать поданный табель на доработку"
        >
          <RotateCcw size={14} /> Отозвать
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

interface IWeekendMemoPopoverProps {
  uploadDisabled: boolean;
  loading: boolean;
  errorText: string | null;
  onUploadClick: () => void;
  onFileSelected: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onClose: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}

const WeekendMemoPopover: FC<IWeekendMemoPopoverProps> = ({
  uploadDisabled,
  loading,
  errorText,
  onUploadClick,
  onFileSelected,
  onClose,
  fileInputRef,
}) => {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const handlePointer = (e: MouseEvent): void => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      // Не закрывать если клик пришёлся на toggle-шеврон — он сам зарелейтил toggle
      const toggle = (e.target as HTMLElement | null)?.closest('.ts-btn-split-toggle');
      if (toggle) return;
      onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handlePointer);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handlePointer);
    };
  }, [onClose]);

  return (
    <div className="ts-memo-popover" role="dialog" aria-label="Прикрепить файл к табелю" ref={popoverRef}>
      <div className="ts-memo-popover-header">
        <div className="ts-memo-popover-title">
          <FileText size={14} /> Прикрепить файл к табелю
        </div>
        <button type="button" className="ts-memo-popover-close" onClick={onClose} aria-label="Закрыть">
          <X size={14} />
        </button>
      </div>

      <div className="ts-memo-popover-hint">
        В выбранном периоде есть работа в выходные/праздники. Приложите файл-подтверждение,
        чтобы подать табель.
      </div>

      {errorText && (
        <div className="ts-memo-popover-error">
          <AlertCircle size={12} /> {errorText}
        </div>
      )}

      <div className="ts-memo-popover-actions">
        <button
          type="button"
          className="ts-btn"
          onClick={onUploadClick}
          disabled={loading || uploadDisabled}
        >
          <Upload size={14} /> Прикрепить файл
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.xlsx"
          style={{ display: 'none' }}
          onChange={onFileSelected}
        />
      </div>
    </div>
  );
};

export const TimesheetApprovalBar: FC<IProps> = ({
  submissionMode,
  departmentId,
  startDate,
  endDate,
  compact = false,
  allowReview = true,
  submitProblems = [],
}) => {
  const { hasPermission, canViewPage, profile } = useAuth();
  const canSubmitDepartment = hasPermission('timesheet.workflow.submit');
  const canReviewApproval = allowReview && hasPermission('timesheet.workflow.review');
  const isManagerObj = profile?.role_code === MANAGER_OBJ_ROLE_CODE;

  // Блокировка периода подачи (зеркалит бэкенд). HR/админ обходят.
  const isHrOrAdmin = canViewPage('/timesheet-hr');
  const periodSubmittable = isHrOrAdmin || isAllowedSubmissionRange({ startDate, endDate });
  const allowedHalf = getAllowedSubmissionHalf();
  const allowedRange = getHalfRange(allowedHalf.year, allowedHalf.month, allowedHalf.half);
  const submitDisabledReason = `Подача доступна только за ${formatTimesheetRangeLabel(allowedRange.startDate, allowedRange.endDate)} — последний завершённый период. За «Весь месяц» подача недоступна.`;
  const queryClient = useQueryClient();
  const isPersonal = submissionMode === 'personal';
  const submissionTarget = isPersonal
    ? ({ mode: 'personal' } as const)
    : ({ mode: 'department', department_id: departmentId } as const);
  const activeStatus = useTimesheetApprovalStatus(submissionMode, departmentId, startDate, endDate);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [missingDays, setMissingDays] = useState<IMissingDay[]>([]);
  const [memoRequired, setMemoRequired] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const memoFileInputRef = useRef<HTMLInputElement>(null);

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
    if (!isPersonal && !departmentId) return;
    setSubmitError(null);
    setMissingDays([]);
    setMemoRequired(false);
    setLoading(true);
    try {
      await timesheetApprovalService.submit(submissionTarget, startDate, endDate);
      await invalidate();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CORRECTION_VALIDATION_FAILED') {
        const days = (err.details?.missing_days as IMissingDay[] | undefined) ?? [];
        setMissingDays(days);
        setSubmitError(err.message);
      } else if (err instanceof ApiError && err.code === 'WEEKEND_MEMO_REQUIRED') {
        setMemoRequired(true);
        setSubmitError(err.message);
        setMemoOpen(true);
      } else if (err instanceof ApiError && err.code === 'SUBMISSION_PERIOD_LOCKED') {
        setSubmitError(err.message);
      } else {
        const message = err instanceof Error ? err.message : 'Ошибка подачи табеля';
        setSubmitError(message);
      }
    } finally {
      setLoading(false);
      setConfirmOpen(false);
    }
  };

  const handleRecall = async () => {
    if (!isPersonal && !departmentId) return;
    setSubmitError(null);
    setMissingDays([]);
    setMemoRequired(false);
    // Guard от race condition: кнопка Recall могла остаться видна из устаревшего
    // кэша, пока статус на бэке уже approved/rejected. Не дёргаем API впустую —
    // показываем ошибку и инвалидируем, чтобы кнопка пропала.
    const currentStatus = activeStatus.data?.status;
    if (currentStatus && currentStatus !== 'submitted') {
      setSubmitError('Табель уже рассмотрен — обновляем статус.');
      await invalidate();
      return;
    }
    await runAction(async () => {
      await timesheetApprovalService.recall(submissionTarget, startDate, endDate);
    });
  };

  const handleUploadMemoClick = () => memoFileInputRef.current?.click();

  const handleMemoFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || (!isPersonal && !departmentId)) return;
    setLoading(true);
    setSubmitError(null);
    try {
      await timesheetApprovalService.uploadAttachment({
        target: submissionTarget,
        start_date: startDate,
        end_date: endDate,
        file,
      });
      setMemoRequired(false);
      await invalidate();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка загрузки служебки';
      setSubmitError(message);
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

  const dismissMissing = () => {
    setMissingDays([]);
    setSubmitError(null);
    setMemoRequired(false);
  };

  const activeApproval = activeStatus.data ?? null;
  const memoSectionAllowed = isManagerObj && canSubmitDepartment && (
    !activeApproval || activeApproval.status === 'draft' || activeApproval.status === 'rejected' || activeApproval.status === 'returned'
  );
  const memoErrorText = memoRequired ? submitError : null;

  return (
    <div className={`ts-approval-bar${compact ? ' ts-approval-bar--compact' : ''}`}>
      <div className="ts-approval-title">
        {compact ? 'Согласование диапазона' : 'Согласование табеля'}
      </div>
      <div className="ts-approval-card-wrap">
        <ActiveCard
          approval={activeStatus.data ?? null}
          canSubmitDepartment={canSubmitDepartment}
          canReviewApproval={canReviewApproval}
          comment={comment}
          compact={compact}
          startDate={startDate}
          endDate={endDate}
          loading={loading}
          periodSubmittable={periodSubmittable}
          submitDisabledReason={submitDisabledReason}
          showMemoToggle={memoSectionAllowed}
          memoOpen={memoOpen}
          onApprove={handleApprove}
          onReject={handleReject}
          onSubmit={() => {
            if (!periodSubmittable) {
              setSubmitError(submitDisabledReason);
              return;
            }
            setConfirmOpen(true);
          }}
          onRecall={handleRecall}
          onToggleMemo={() => setMemoOpen(o => !o)}
          onCommentChange={setComment}
        />
        <TimesheetSubmitConfirmModal
          open={confirmOpen}
          period={formatTimesheetRangeLabel(startDate, endDate)}
          problems={submitProblems}
          loading={loading}
          onConfirm={handleSubmit}
          onClose={() => setConfirmOpen(false)}
        />
        {memoOpen && memoSectionAllowed && (
          <WeekendMemoPopover
            uploadDisabled={!isPersonal && !departmentId}
            loading={loading}
            errorText={memoErrorText}
            onUploadClick={handleUploadMemoClick}
            onFileSelected={handleMemoFileSelected}
            onClose={() => setMemoOpen(false)}
            fileInputRef={memoFileInputRef}
          />
        )}
      </div>
      {(submitError || missingDays.length > 0) && !memoRequired && (
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
    </div>
  );
};
