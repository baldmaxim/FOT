import { type FC, Fragment, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Unlock, X } from 'lucide-react';

import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { getTimesheetDepartmentPeriodQueryKey } from '../../hooks/useTimesheetApprovalData';
import { timesheetApprovalService, type IDepartmentPeriodRef } from '../../services/timesheetApprovalService';
import {
  resolveDepartmentPeriodHalfButtons,
  type IDepartmentPeriodHalfButtons,
} from '../../utils/departmentPeriodActions';
import styles from './TimesheetDepartmentPeriodActions.module.css';

const getDepartmentPeriodQueryKey = (ref: IDepartmentPeriodRef) =>
  getTimesheetDepartmentPeriodQueryKey(ref.department_id, ref.start_date, ref.end_date);

interface IDialogProps {
  departmentId: string;
  /** Половина, по кнопке которой открыто окно: снимок на момент нажатия. */
  half: IDepartmentPeriodHalfButtons;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}

/** Запросы окна — строго за половину нажатой кнопки. */
const halfRef = (departmentId: string, half: IDepartmentPeriodHalfButtons): IDepartmentPeriodRef => ({
  department_id: departmentId,
  start_date: half.start_date,
  end_date: half.end_date,
});

const OpenDialog: FC<IDialogProps> = ({ departmentId, half, onClose, onDone }) => {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const overlay = useOverlayDismiss(() => { if (!submitting) onClose(); });
  const periodRef = halfRef(departmentId, half);
  // Один id на окно: повтор после обрыва связи вернёт прежний результат и ничего не откроет заново.
  const operationId = useRef(crypto.randomUUID());

  const previewQuery = useQuery({
    queryKey: [...getDepartmentPeriodQueryKey(periodRef), 'preview'],
    queryFn: ({ signal }) => timesheetApprovalService.previewDepartmentPeriod(periodRef, signal),
    staleTime: 0,
    gcTime: 0,
  });
  const preview = previewQuery.isSuccess && !previewQuery.isFetching ? previewQuery.data : undefined;
  const nothingToOpen = preview?.expected_approval_ids.length === 0;

  const handleConfirm = async () => {
    if (!preview || preview.expected_approval_ids.length === 0) return;
    setSubmitting(true);
    try {
      await timesheetApprovalService.openDepartmentPeriod({
        ...periodRef,
        operation_ids: { [half.half]: operationId.current },
        expected_approval_ids: preview.expected_approval_ids,
        reason: reason.trim() || null,
      });
      toast.success('Табель открыт для правок');
      await onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Ошибка открытия табеля');
      // Состав изменился: берём новый, человек подтверждает заново.
      if (err instanceof ApiError && err.status === 409) void previewQuery.refetch();
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="ts-exclude-modal-overlay" {...overlay}>
      <div className="ts-exclude-modal" role="dialog" aria-modal="true" aria-label="Открыть табель для правок">
        <div className="ts-exclude-modal-header">
          <h3>Открыть табель для правок?</h3>
          <button type="button" className="ts-exclude-modal-close" onClick={onClose} disabled={submitting} aria-label="Закрыть окно">
            <X size={18} />
          </button>
        </div>
        <div className="ts-exclude-modal-body">
          <p>
            Табель за {half.periodLabel} будет временно открыт: руководители и табельщицы смогут вносить
            корректировки. Статус согласования не изменится. Не забудьте закрыть период после правок.
          </p>
          {previewQuery.isError && !previewQuery.isFetching && <p>Не удалось загрузить состав табелей.</p>}
          {nothingToOpen && <p>Закрытых табелей за этот период уже нет.</p>}
          <textarea
            className="ts-approval-input"
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

const CloseDialog: FC<IDialogProps> = ({ departmentId, half, onClose, onDone }) => {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const overlay = useOverlayDismiss(() => { if (!submitting) onClose(); });
  const periodRef = halfRef(departmentId, half);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const { closed, failed } = await timesheetApprovalService.closeDepartmentPeriod(periodRef);
      const first = failed[0];
      if (first) {
        toast.error(`Закрыто ${closed.length} из ${closed.length + failed.length}. ${first.label}: ${first.error}`);
      } else {
        toast.success('Табель закрыт — правки запрещены');
      }
      await onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Ошибка закрытия табеля');
      await onDone();
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="ts-exclude-modal-overlay" {...overlay}>
      <div className="ts-exclude-modal" role="dialog" aria-modal="true" aria-label="Закрыть табель">
        <div className="ts-exclude-modal-header">
          <h3>Закрыть табель?</h3>
          <button type="button" className="ts-exclude-modal-close" onClick={onClose} disabled={submitting} aria-label="Закрыть окно">
            <X size={18} />
          </button>
        </div>
        <div className="ts-exclude-modal-body">
          <p>
            Табель за {half.periodLabel} снова будет закрыт: корректировки и правки станут недоступны всем, кроме
            администратора.
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

interface IProps {
  departmentId: string;
  startDate: string;
  endDate: string;
}

/**
 * «Открыть/Закрыть табель» отдела: вместе с табелем отдела — личные табели, держащие строки его людей.
 * У каждой половины свои кнопки (как во вкладке «Выходные»); в «Весь месяц» — с подписью половины, в «1–15» /
 * «16–31» — без неё. Кнопки только по ответу сервера для ЭТОГО отдела и диапазона: пока ответа нет — кнопок нет.
 */
export const TimesheetDepartmentPeriodActions: FC<IProps> = ({ departmentId, startDate, endDate }) => {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ kind: 'open' | 'close'; half: IDepartmentPeriodHalfButtons } | null>(null);
  const periodRef: IDepartmentPeriodRef = { department_id: departmentId, start_date: startDate, end_date: endDate };

  const stateQuery = useQuery({
    queryKey: getDepartmentPeriodQueryKey(periodRef),
    queryFn: ({ signal }) => timesheetApprovalService.getDepartmentPeriod(periodRef, signal),
    staleTime: 30_000,
    retry: false,
  });
  const halves = resolveDepartmentPeriodHalfButtons(stateQuery.isSuccess ? stateQuery.data : null);
  // Подпись половины нужна, только когда в диапазоне их две («Весь месяц»).
  const withLabels = (stateQuery.data?.halves.length ?? 0) > 1;

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
    queryClient.invalidateQueries({ queryKey: ['staff-weekends'] }),
  ]);

  const renderButtons = (half: IDepartmentPeriodHalfButtons) => (
    <>
      {half.canOpen && (
        <button
          className="ts-btn"
          onClick={() => setDialog({ kind: 'open', half })}
          type="button"
          title="Временно открыть табель — руководители и табельщицы смогут внести правки"
        >
          <Unlock size={14} /> Открыть табель
        </button>
      )}
      {half.canClose && (
        <button
          className="ts-btn ts-btn--primary"
          onClick={() => setDialog({ kind: 'close', half })}
          type="button"
          title="Закрыть табель — правки снова запрещены"
        >
          <Lock size={14} /> Закрыть табель
        </button>
      )}
    </>
  );

  return (
    <>
      {withLabels ? (
        // Половины друг под другом: в ряд две пары не помещаются в шапку на 1280 px и наезжают на месяц.
        halves.length > 0 && (
          <div className={styles.periods}>
            {halves.map(half => (
              <div key={half.half} className={styles.period}>
                <span className={styles.periodLabel}>{half.periodLabel}</span>
                <span className={styles.periodButtons}>{renderButtons(half)}</span>
              </div>
            ))}
          </div>
        )
      ) : halves.map(half => <Fragment key={half.half}>{renderButtons(half)}</Fragment>)}
      {dialog?.kind === 'open' && (
        <OpenDialog departmentId={departmentId} half={dialog.half} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog?.kind === 'close' && (
        <CloseDialog departmentId={departmentId} half={dialog.half} onClose={() => setDialog(null)} onDone={refresh} />
      )}
    </>
  );
};
