import { type FC, type MouseEvent as ReactMouseEvent } from 'react';
import { CalendarX, CheckCircle, FilePen, Paperclip, UserCheck, XCircle } from 'lucide-react';
import { REQUEST_TYPE_LABELS, type ILeaveRequestAttachment } from '../../services/leaveRequestService';
import type {
  HrCorrectionItem,
  IHrCorrectionLeave,
  IHrCorrectionRemoved,
} from '../../services/correctionLeaveService';
import { formatDaysCompact } from '../../utils/hrAckItems';
import { displayFileName } from '../../utils/fileNameDisplay';
import { formatFioShort } from '../../utils/formatFio';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

const REMOVED_KIND_LABELS: Record<IHrCorrectionRemoved['removed_kind'], string> = {
  deleted: 'удалён из табеля',
  status_changed: 'в табеле стоит другой статус',
  mixed: 'удалён или изменён в табеле',
};

interface IHrCorrectionLeaveCardProps {
  item: HrCorrectionItem;
  /** Право edit на /leave-vacations: без него кнопок нет, состояние видно. */
  canEdit: boolean;
  isBusy: boolean;
  onAcknowledge: (item: IHrCorrectionLeave | IHrCorrectionRemoved) => void;
  onReject: (item: IHrCorrectionLeave) => void;
  onOpenAttachment: (att: ILeaveRequestAttachment) => void;
}

/**
 * Карточка вкладки «Отпуска» для отпуска, поставленного корректировкой табеля:
 * сама корректировка («Ознакомлен» / «Отказать»), дни, снятые после ознакомления,
 * и отказ кадров.
 */
export const HrCorrectionLeaveCard: FC<IHrCorrectionLeaveCardProps> = ({
  item,
  canEdit,
  isBusy,
  onAcknowledge,
  onReject,
  onOpenAttachment,
}) => {
  const stop = (e: ReactMouseEvent) => e.stopPropagation();
  const isAcked = !!item.hr_acknowledged_at;

  const status = (() => {
    switch (item.kind) {
      case 'correction':
        return {
          className: 'lrm-status--correction',
          icon: <FilePen size={14} />,
          label: 'Корректировка табеля',
          meta: item.author_name ? formatFioShort(item.author_name) : '',
        };
      case 'removed':
        return {
          className: 'lrm-status--removed',
          icon: <CalendarX size={14} />,
          label: 'Снят после ознакомления',
          meta: formatDate(item.removed_at),
        };
      case 'rejected':
        return {
          className: 'lrm-status--rejected',
          icon: <XCircle size={14} />,
          label: 'Отказано',
          meta: [formatFioShort(item.rejected_by_name), formatDate(item.rejected_at)].filter(Boolean).join(' · '),
        };
    }
  })();

  return (
    <div className="lrm-card">
      <div className="lrm-card-main">
        <div className="lrm-card-top">
          <div className="lrm-card-employee-block">
            <span className="lrm-card-employee">{item.employee_name || `#${item.employee_id}`}</span>
            {(item.department_name || item.position_name) && (
              <div className="lrm-card-meta">
                {item.department_name}
                {item.department_name && item.position_name ? ' · ' : ''}
                {item.position_name}
              </div>
            )}
          </div>
          <div className="lrm-status-wrap">
            <span className={`lrm-status ${status.className}`}>
              {status.icon} <strong>{status.label}</strong>
            </span>
            {status.meta && <div className="lrm-status-meta">{status.meta}</div>}
          </div>
        </div>
        <div className="lrm-card-type">{REQUEST_TYPE_LABELS[item.leave_status]}</div>
        <div className="lrm-card-dates">
          <strong>{formatDaysCompact(item.days)}</strong>
          {item.kind === 'removed' && <> — {REMOVED_KIND_LABELS[item.removed_kind]}</>}
        </div>
        {item.kind !== 'removed' && item.reason && <div className="lrm-card-reason">{item.reason}</div>}
        {item.kind === 'correction' && item.attachments.length > 0 && (
          <div className="lrm-attachments" onClick={stop}>
            {item.attachments.map(att => (
              <button
                key={att.id}
                type="button"
                className="lrm-attachment-btn"
                onClick={(e) => { e.stopPropagation(); onOpenAttachment(att); }}
                title={att.file_name}
              >
                <Paperclip size={12} />
                <span className="lrm-attachment-name">{displayFileName(att.file_name)}</span>
              </button>
            ))}
          </div>
        )}
        {item.kind === 'rejected' && (
          <div className="lrm-card-comment">
            <span className="lrm-card-comment-label">Причина отказа:</span> {item.reject_reason}
          </div>
        )}
      </div>

      <div className="lrm-card-actions" onClick={stop}>
        {item.kind === 'rejected' ? (
          <div className="lrm-hr-ack lrm-hr-ack--rejected">
            <XCircle size={15} /> Снят из табеля по отказу
          </div>
        ) : isAcked ? (
          <div className="lrm-hr-ack">
            <CheckCircle size={15} /> Ознакомлен
            {item.hr_acknowledged_by_name && <> · {formatFioShort(item.hr_acknowledged_by_name)}</>}
          </div>
        ) : canEdit ? (
          <div className="lrm-action-row">
            <button
              type="button"
              className="lrm-ack-btn lrm-ack-btn--pending"
              disabled={isBusy}
              onClick={() => onAcknowledge(item)}
            >
              <UserCheck size={14} /> {isBusy ? 'Отмечаем…' : 'Ознакомлен'}
            </button>
            {item.kind === 'correction' && (
              <button
                type="button"
                className="lrm-action-btn reject"
                disabled={isBusy}
                onClick={() => onReject(item)}
              >
                <XCircle size={14} /> Отказать
              </button>
            )}
          </div>
        ) : (
          <div className="lrm-hr-ack lrm-hr-ack--pending">Не ознакомлен</div>
        )}
      </div>
    </div>
  );
};
