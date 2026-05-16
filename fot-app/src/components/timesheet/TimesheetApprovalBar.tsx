import { type FC, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Check, X, Send, Clock, CheckCircle, XCircle, RotateCcw, AlertCircle,
  Download, Upload, FileText, ChevronDown,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  timesheetApprovalService,
  APPROVAL_STATUS_LABELS,
  type ITimesheetApproval,
  type TimesheetApprovalStatus,
} from '../../services/timesheetApprovalService';
import { timesheetService } from '../../services/timesheetService';
import { ApiError } from '../../api/client';
import {
  useTimesheetApprovalStatus,
  useTimesheetDepartmentApprovals,
  useWeekendMemoPreview,
} from '../../hooks/useTimesheetApprovalData';
import { formatTimesheetRangeLabel } from '../../utils/timesheetApprovalPeriod';
import {
  TimesheetSubmitConfirmModal,
  type ISubmitProblemEmployee,
} from './TimesheetSubmitConfirmModal';

const MANAGER_OBJ_ROLE_CODE = 'manager_obj';

interface IProps {
  departmentId: string | null;
  month: string; // YYYY-MM (для списка всех согласований месяца)
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

export const STATUS_COLORS: Record<TimesheetApprovalStatus, string> = {
  draft: '#6b7280',
  submitted: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  returned: '#f59e0b',
};

export const STATUS_ICONS: Record<TimesheetApprovalStatus, FC<{ size?: number }>> = {
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

const formatRu = (iso: string): string => {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
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
  departmentId: string | null;
  startDate: string;
  endDate: string;
  memoReason: string;
  loading: boolean;
  downloading: boolean;
  errorText: string | null;
  onChangeReason: (value: string) => void;
  onDownload: () => Promise<void>;
  onUploadClick: () => void;
  onFileSelected: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onClose: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}

const WeekendMemoPopover: FC<IWeekendMemoPopoverProps> = ({
  departmentId,
  startDate,
  endDate,
  memoReason,
  loading,
  downloading,
  errorText,
  onChangeReason,
  onDownload,
  onUploadClick,
  onFileSelected,
  onClose,
  fileInputRef,
}) => {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preview = useWeekendMemoPreview(departmentId, startDate, endDate, true);
  const entries = preview.data?.entries ?? [];
  const weekendDates = preview.data?.weekend_dates ?? [];
  const hasEntries = entries.length > 0;
  const hasWeekendDays = weekendDates.length > 0;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

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
    <div className="ts-memo-popover" role="dialog" aria-label="Служебная записка о работе в выходные" ref={popoverRef}>
      <div className="ts-memo-popover-header">
        <div className="ts-memo-popover-title">
          <FileText size={14} /> Служебная записка о работе в выходные
        </div>
        <button type="button" className="ts-memo-popover-close" onClick={onClose} aria-label="Закрыть">
          <X size={14} />
        </button>
      </div>

      <div className="ts-memo-popover-hint">
        В шаблон попадут сотрудники, у которых в «Режиме корректировок» выходной/праздничный день
        помечен статусом «работа». Чтобы добавить или убрать — выделите ячейки в табеле.
      </div>

      <div className="ts-memo-popover-list">
        {preview.isLoading && <div className="ts-memo-popover-empty">Загрузка…</div>}
        {!preview.isLoading && !hasWeekendDays && (
          <div className="ts-memo-popover-empty">В выбранном диапазоне нет выходных/праздничных дней.</div>
        )}
        {!preview.isLoading && hasWeekendDays && !hasEntries && (
          <div className="ts-memo-popover-empty">
            Пока нет корректировок «работа» на выходные дни диапазона.
          </div>
        )}
        {hasEntries && (
          <ul className="ts-memo-popover-items">
            {entries.map((entry) => (
              <li key={entry.employee_id} className="ts-memo-popover-item">
                <span className="ts-memo-popover-name">{entry.full_name || `#${entry.employee_id}`}</span>
                <span className="ts-memo-popover-dates">
                  {entry.work_dates.map(formatRu).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <textarea
        ref={textareaRef}
        className="ts-memo-popover-reason"
        placeholder="Кратко обоснуйте необходимость работы в выходные (попадёт в шаблон)"
        value={memoReason}
        onChange={e => onChangeReason(e.target.value)}
        rows={2}
      />

      {errorText && (
        <div className="ts-memo-popover-error">
          <AlertCircle size={12} /> {errorText}
        </div>
      )}

      <div className="ts-memo-popover-actions">
        <button
          type="button"
          className="ts-btn"
          onClick={onDownload}
          disabled={downloading || !departmentId || !hasEntries}
          title={!hasEntries ? 'Сначала отметьте корректировкой выходные дни как «работа»' : undefined}
        >
          <Download size={14} /> Скачать шаблон
        </button>
        <button
          type="button"
          className="ts-btn"
          onClick={onUploadClick}
          disabled={loading || !departmentId}
        >
          <Upload size={14} /> Загрузить подписанную
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
  departmentId,
  month,
  startDate,
  endDate,
  compact = false,
  allowReview = true,
  submitProblems = [],
}) => {
  const { hasPermission, profile } = useAuth();
  const canSubmitDepartment = hasPermission('timesheet.workflow.submit');
  const canReviewApproval = allowReview && hasPermission('timesheet.workflow.review');
  const isManagerObj = profile?.role_code === MANAGER_OBJ_ROLE_CODE;
  const queryClient = useQueryClient();
  const activeStatus = useTimesheetApprovalStatus(departmentId, startDate, endDate);
  const monthApprovals = useTimesheetDepartmentApprovals(departmentId, month);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [missingDays, setMissingDays] = useState<IMissingDay[]>([]);
  const [memoRequired, setMemoRequired] = useState(false);
  const [memoReason, setMemoReason] = useState('');
  const [memoDownloading, setMemoDownloading] = useState(false);
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
    if (!departmentId) return;
    setSubmitError(null);
    setMissingDays([]);
    setMemoRequired(false);
    setLoading(true);
    try {
      await timesheetApprovalService.submit(departmentId, startDate, endDate);
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
    if (!departmentId) return;
    setSubmitError(null);
    setMissingDays([]);
    setMemoRequired(false);
    await runAction(async () => {
      await timesheetApprovalService.recall(departmentId, startDate, endDate);
    });
  };

  const handleDownloadMemo = async () => {
    if (!departmentId) return;
    setMemoDownloading(true);
    try {
      const blob = await timesheetService.generateWeekendMemo({
        department_id: departmentId,
        start_date: startDate,
        end_date: endDate,
        reason: memoReason,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `weekend-memo-${startDate}_${endDate}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка скачивания служебки';
      setSubmitError(message);
    } finally {
      setMemoDownloading(false);
    }
  };

  const handleUploadMemoClick = () => memoFileInputRef.current?.click();

  const handleMemoFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !departmentId) return;
    setLoading(true);
    setSubmitError(null);
    try {
      await timesheetApprovalService.uploadAttachment({
        department_id: departmentId,
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

  const otherApprovals = (monthApprovals.data ?? []).filter(approval => {
    const active = activeStatus.data;
    if (!active) return true;
    return approval.id !== active.id;
  });

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
          showMemoToggle={memoSectionAllowed}
          memoOpen={memoOpen}
          onApprove={handleApprove}
          onReject={handleReject}
          onSubmit={() => setConfirmOpen(true)}
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
            departmentId={departmentId}
            startDate={startDate}
            endDate={endDate}
            memoReason={memoReason}
            loading={loading}
            downloading={memoDownloading}
            errorText={memoErrorText}
            onChangeReason={setMemoReason}
            onDownload={handleDownloadMemo}
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
