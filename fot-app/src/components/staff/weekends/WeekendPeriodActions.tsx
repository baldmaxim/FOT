import { type FC, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Unlock, X } from 'lucide-react';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import {
  STAFF_WEEKENDS_KEY,
  staffWeekendService,
  type IStaffWeekendBranch,
  type IStaffWeekendPeriod,
  type IStaffWeekendPeriodRef,
} from '../../../services/staffWeekendService';
import { APPROVAL_STATUS_LABELS } from '../../../services/timesheetApprovalService';
import { formatTimesheetRangeLabel } from '../../../utils/timesheetApprovalPeriod';
import styles from './WeekendsTab.module.css';

type DialogKind = 'open' | 'close';

interface IDialogProps {
  branchName: string;
  period: IStaffWeekendPeriod;
  periodRef: IStaffWeekendPeriodRef;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}

const OpenDialog: FC<IDialogProps> = ({ branchName, period, periodRef, onClose, onDone }) => {
  const toast = useToast();
  const overlay = useOverlayDismiss(onClose);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // На одно окно один id: повтор после обрыва связи не откроет ничего заново.
  const operationId = useRef(crypto.randomUUID());
  const label = formatTimesheetRangeLabel(period.start_date, period.end_date);

  const previewQuery = useQuery({
    queryKey: [...STAFF_WEEKENDS_KEY, 'preview', periodRef.branch_id, periodRef.month, periodRef.half],
    queryFn: ({ signal }) => staffWeekendService.previewPeriod(periodRef, signal),
    staleTime: 0,
    gcTime: 0,
  });
  const preview = previewQuery.data;

  const handleConfirm = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      await staffWeekendService.openPeriod({
        ...periodRef,
        operation_id: operationId.current,
        expected_approval_ids: preview.expected_approval_ids,
        reason: reason.trim() || null,
      });
      toast.success(`Табель ${branchName} открыт для правок`);
      await onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Ошибка открытия табеля');
      // Состав изменился: показываем новый, человек подтверждает его заново.
      if (err instanceof ApiError && err.status === 409) void previewQuery.refetch();
      setSubmitting(false);
    }
  };

  const nothingToOpen = preview?.expected_approval_ids.length === 0;

  return createPortal(
    <div className="ts-exclude-modal-overlay" {...overlay}>
      <div className="ts-exclude-modal" role="dialog" aria-modal="true" aria-label={`Открыть табель ${branchName}`}>
        <div className="ts-exclude-modal-header">
          <h3>Открыть табель {branchName}?</h3>
          <button type="button" className="ts-exclude-modal-close" onClick={onClose} disabled={submitting} aria-label="Закрыть окно">
            <X size={18} />
          </button>
        </div>
        <div className="ts-exclude-modal-body">
          <p className={styles.dialogText}>
            За {label} будут временно открыты табели целиком: руководители и табельщицы смогут вносить корректировки.
            Статус согласования не изменится. Не забудьте закрыть табель после правок.
          </p>
          {previewQuery.isLoading && <p className={styles.dialogText}>Считаем состав…</p>}
          {previewQuery.isError && <p className={styles.dialogText}>Не удалось загрузить состав табелей.</p>}
          {nothingToOpen && <p className={styles.dialogText}>Закрытых дней из списка за этот период уже нет.</p>}
          {preview && preview.approvals.length > 0 && (
            <>
              <p className={styles.dialogHeading}>Откроется табелей: {preview.approvals.length}</p>
              <ul className={styles.dialogList}>
                {preview.approvals.map(approval => (
                  <li key={approval.id} className={styles.dialogListItem}>
                    <span>{approval.label}</span>
                    <span className={styles.dialogListMeta}>
                      {APPROVAL_STATUS_LABELS[approval.status as keyof typeof APPROVAL_STATUS_LABELS] ?? approval.status}, {approval.people_count} чел.
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview && preview.others.length > 0 && (
            <>
              <p className={styles.dialogHeading}>Откроются дни людей из других отделов:</p>
              <ul className={styles.dialogList}>
                {preview.others.map(group => (
                  <li key={group.department} className={styles.dialogListItem}>
                    <span>
                      {group.names.join(', ')}
                      {group.count > group.names.length ? ` и ещё ${group.count - group.names.length}` : ''}
                    </span>
                    <span className={styles.dialogListMeta}>{group.department}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <textarea
            className={styles.dialogReason}
            placeholder="Причина открытия (необязательно)"
            maxLength={500}
            rows={2}
            value={reason}
            onChange={event => setReason(event.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="ts-exclude-modal-footer">
          <button type="button" className="ts-exclude-modal-cancel" onClick={onClose} disabled={submitting}>Отмена</button>
          <button
            type="button"
            className="ts-exclude-modal-confirm"
            onClick={() => { void handleConfirm(); }}
            disabled={submitting || !preview || nothingToOpen}
          >
            <Unlock size={14} aria-hidden="true" /> {submitting ? 'Открываем…' : 'Открыть табель'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const CloseDialog: FC<IDialogProps> = ({ branchName, period, periodRef, onClose, onDone }) => {
  const toast = useToast();
  const overlay = useOverlayDismiss(onClose);
  const [submitting, setSubmitting] = useState(false);
  const label = formatTimesheetRangeLabel(period.start_date, period.end_date);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const { closed, failed } = await staffWeekendService.closePeriod(periodRef);
      const first = failed[0];
      if (first) {
        toast.error(`Закрыто ${closed.length} из ${closed.length + failed.length}. ${first.label}: ${first.error}`);
      } else {
        toast.success(`Табель ${branchName} закрыт — правки запрещены`);
      }
      await onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Ошибка закрытия табеля');
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="ts-exclude-modal-overlay" {...overlay}>
      <div className="ts-exclude-modal" role="dialog" aria-modal="true" aria-label={`Закрыть табель ${branchName}`}>
        <div className="ts-exclude-modal-header">
          <h3>Закрыть табель {branchName}?</h3>
          <button type="button" className="ts-exclude-modal-close" onClick={onClose} disabled={submitting} aria-label="Закрыть окно">
            <X size={18} />
          </button>
        </div>
        <div className="ts-exclude-modal-body">
          <p className={styles.dialogText}>
            За {label} закроется всё, что открыто этой кнопкой, и правки снова будут запрещены. Если данные изменились,
            у утверждённых табелей появится новая редакция для 1С. Табель, открытый вручную в разделе «Табель», закрывается там.
          </p>
        </div>
        <div className="ts-exclude-modal-footer">
          <button type="button" className="ts-exclude-modal-cancel" onClick={onClose} disabled={submitting}>Отмена</button>
          <button type="button" className="ts-exclude-modal-confirm" onClick={() => { void handleConfirm(); }} disabled={submitting}>
            <Lock size={14} aria-hidden="true" /> {submitting ? 'Закрываем…' : 'Закрыть табель'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

interface IWeekendPeriodActionsProps {
  branch: Pick<IStaffWeekendBranch, 'id' | 'name' | 'periods'>;
  /** YYYY-MM */
  month: string;
}

/** Кнопки отдела в шапке сетки: своя пара на половину месяца, другой отдел не затрагивается. */
export const WeekendPeriodActions: FC<IWeekendPeriodActionsProps> = ({ branch, month }) => {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ kind: DialogKind; period: IStaffWeekendPeriod } | null>(null);

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: STAFF_WEEKENDS_KEY }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
  ]);

  const dialogProps = dialog && {
    branchName: branch.name,
    period: dialog.period,
    periodRef: { month, half: dialog.period.half, branch_id: branch.id },
    onClose: () => setDialog(null),
    onDone: refresh,
  };

  return (
    <div className={styles.periodActions}>
      {branch.periods.map(period => (
        <div key={period.half} className={styles.period}>
          <span className={styles.periodLabel}>{formatTimesheetRangeLabel(period.start_date, period.end_date)}</span>
          {period.can_open && (
            <button type="button" className={styles.periodButton} onClick={() => setDialog({ kind: 'open', period })}>
              <Unlock size={14} aria-hidden="true" /> Открыть табель
            </button>
          )}
          {period.can_close && (
            <button
              type="button"
              className={`${styles.periodButton} ${styles.periodButtonClose}`}
              onClick={() => setDialog({ kind: 'close', period })}
            >
              <Lock size={14} aria-hidden="true" /> Закрыть табель
            </button>
          )}
        </div>
      ))}
      {dialog?.kind === 'open' && dialogProps && <OpenDialog {...dialogProps} />}
      {dialog?.kind === 'close' && dialogProps && <CloseDialog {...dialogProps} />}
    </div>
  );
};
