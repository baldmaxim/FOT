import { type FC } from 'react';
import { X, Send, AlertTriangle } from 'lucide-react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';

export interface ISubmitProblemDay {
  date: string; // YYYY-MM-DD
  reason: string;
}

export interface ISubmitProblemEmployee {
  employeeId: number;
  employeeName: string;
  days: ISubmitProblemDay[];
}

interface IProps {
  open: boolean;
  period: string;
  problems: ISubmitProblemEmployee[];
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

const formatDay = (iso: string): string => {
  const [, m, d] = iso.split('-');
  return `${Number(d)}.${m}`;
};

export const TimesheetSubmitConfirmModal: FC<IProps> = ({
  open,
  period,
  problems,
  loading,
  onConfirm,
  onClose,
}) => {
  const overlayHandlers = useOverlayDismiss(onClose);

  if (!open) return null;

  const hasProblems = problems.length > 0;

  return (
    <div className="ts-exclude-modal-overlay" {...overlayHandlers}>
      <div className="ts-exclude-modal ts-submit-confirm-modal" onClick={e => e.stopPropagation()}>
        <div className="ts-exclude-modal-header">
          <h3>Подтверждение подачи табеля</h3>
          <button type="button" className="ts-exclude-modal-close" onClick={onClose} disabled={loading}>
            <X size={18} />
          </button>
        </div>
        <div className="ts-exclude-modal-body">
          <div className="ts-submit-confirm-period">Период: {period}</div>

          {!hasProblems && (
            <p className="ts-submit-confirm-empty">
              Проблемных дней не найдено. Можно подавать табель на согласование.
            </p>
          )}

          {hasProblems && (
            <>
              <div className="ts-submit-confirm-warn">
                <AlertTriangle size={14} />
                <span>
                  Есть дни, требующие внимания (не учитываются недоработки по графику и неявки).
                  Подача возможна, но проверьте список.
                </span>
              </div>
              <ul className="ts-submit-confirm-list">
                {problems.map(emp => (
                  <li key={emp.employeeId} className="ts-submit-confirm-emp">
                    <span className="ts-submit-confirm-emp-name">{emp.employeeName}</span>
                    <span className="ts-submit-confirm-days">
                      {emp.days.map(d => (
                        <span key={d.date} className="ts-submit-confirm-day">
                          {formatDay(d.date)} — {d.reason}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="ts-exclude-modal-footer">
          <button type="button" className="ts-exclude-modal-cancel" onClick={onClose} disabled={loading}>
            Отмена
          </button>
          <button
            type="button"
            className="ts-exclude-modal-confirm ts-submit-confirm-go"
            onClick={onConfirm}
            disabled={loading}
          >
            <Send size={14} />
            {loading ? 'Подача…' : 'Подтвердить и подать'}
          </button>
        </div>
      </div>
    </div>
  );
};
