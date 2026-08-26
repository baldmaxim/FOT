import { type FC, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Clock,
  CheckCircle,
  XCircle,
  Ban,
  Paperclip,
  UserCheck,
  Pencil,
} from 'lucide-react';
import {
  REQUEST_TYPE_LABELS,
  VACATION_REQUEST_TYPES,
  getRequestDecision,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
  type LeaveRequestStatus,
  type LeaveRequestType,
} from '../../services/leaveRequestService';
import type { HrAckRequestsVariant } from '../../hooks/usePortalData';
import { formatLeaveRequestDatesCompact } from '../../utils/leaveRequestDates';
import { displayFileName } from '../../utils/fileNameDisplay';
import { formatFioShort } from '../../utils/formatFio';

const STATUS_COLORS: Record<LeaveRequestStatus, string> = {
  pending: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  cancelled: '#6b7280',
};

const STATUS_ICONS: Record<LeaveRequestStatus, FC<{ size?: number }>> = {
  pending: Clock,
  approved: CheckCircle,
  rejected: XCircle,
  cancelled: Ban,
};

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Открытый редактор категории (только «Отпуска»): состояние черновика этой карточки. */
export interface IHrAckTypeEditor {
  draft: LeaveRequestType;
  saving: boolean;
  onDraftChange: (next: LeaveRequestType) => void;
  onSave: () => void;
  onCancel: () => void;
}

interface IHrAckRequestCardProps {
  request: ILeaveRequest;
  variant: HrAckRequestsVariant;
  /** Право edit на маркер вкладки: без него кнопки «Ознакомлен» нет, отметка видна. */
  canAcknowledge: boolean;
  isAcking: boolean;
  onAcknowledge: (id: number) => void;
  /** Задан, когда категорию этой карточки можно править (кнопка-карандаш). */
  onStartEditType?: () => void;
  /** Задан, когда редактор категории открыт именно у этой карточки. */
  typeEditor?: IHrAckTypeEditor;
  onOpenAttachment: (att: ILeaveRequestAttachment) => void;
}

export const HrAckRequestCard: FC<IHrAckRequestCardProps> = ({
  request: r,
  variant,
  canAcknowledge,
  isAcking,
  onAcknowledge,
  onStartEditType,
  typeEditor,
  onOpenAttachment,
}) => {
  const Icon = STATUS_ICONS[r.status];
  const decision = getRequestDecision(r);
  const isAcked = !!r.hr_acknowledged_at;
  const stop = (e: ReactMouseEvent) => e.stopPropagation();

  return (
    <div className="lrm-card">
      <div className="lrm-card-main">
        <div className="lrm-card-top">
          <div className="lrm-card-employee-block">
            <span className="lrm-card-employee">{r.employee_name || `#${r.employee_id}`}</span>
            {(r.department_name || r.position_name) && (
              <div className="lrm-card-meta">
                {r.department_name}
                {r.department_name && r.position_name ? ' · ' : ''}
                {r.position_name}
              </div>
            )}
          </div>
          <div className="lrm-status-wrap">
            <span className="lrm-status" style={{ color: STATUS_COLORS[r.status] }}>
              <Icon size={14} /> <strong>{decision.label}</strong>
            </span>
            {(decision.actor || decision.at) && (
              <div className="lrm-status-meta">
                {formatFioShort(decision.actor)}
                {decision.actor && decision.at ? ' · ' : ''}
                {decision.at ? formatDate(decision.at) : ''}
              </div>
            )}
          </div>
        </div>
        {typeEditor ? (
          <div className="lrm-type-edit" onClick={stop}>
            <select
              className="lrm-type-select"
              value={typeEditor.draft}
              onChange={(e) => typeEditor.onDraftChange(e.target.value as LeaveRequestType)}
              disabled={typeEditor.saving}
              autoFocus
              aria-label="Категория заявления"
            >
              {VACATION_REQUEST_TYPES.map(t => (
                <option key={t} value={t}>{REQUEST_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <button
              type="button"
              className="lrm-action-btn approve"
              disabled={typeEditor.saving}
              onClick={(e) => { e.stopPropagation(); typeEditor.onSave(); }}
            >
              {typeEditor.saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button
              type="button"
              className="lrm-action-btn ghost"
              disabled={typeEditor.saving}
              onClick={(e) => { e.stopPropagation(); typeEditor.onCancel(); }}
            >
              Отмена
            </button>
          </div>
        ) : onStartEditType ? (
          <div className="lrm-card-type">
            <button
              type="button"
              className="lrm-type-btn"
              onClick={(e) => { e.stopPropagation(); onStartEditType(); }}
              title="Изменить категорию"
            >
              {REQUEST_TYPE_LABELS[r.request_type]} <Pencil size={12} />
            </button>
          </div>
        ) : (
          <div className="lrm-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>
        )}
        <div className="lrm-card-dates">
          {variant === 'dismissals' ? (
            // У увольнения одна дата (start_date = end_date) — последний рабочий день.
            <>Последний рабочий день: <strong>{formatDate(r.start_date)}</strong></>
          ) : (
            <strong>{formatLeaveRequestDatesCompact(r)}</strong>
          )}
        </div>
        {r.reason && <div className="lrm-card-reason">{r.reason}</div>}
        {r.attachments && r.attachments.length > 0 && (
          <div className="lrm-attachments" onClick={stop}>
            {r.attachments.map(att => (
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
        {decision.comment && (
          <div className="lrm-card-comment">
            <span className="lrm-card-comment-label">
              {r.status === 'cancelled' ? 'Причина:' : 'Комментарий:'}
            </span> {decision.comment}
          </div>
        )}
      </div>

      <div className="lrm-card-actions" onClick={stop}>
        {isAcked ? (
          <div className="lrm-hr-ack">
            <CheckCircle size={15} /> Ознакомлен
          </div>
        ) : canAcknowledge ? (
          <button
            className="lrm-ack-btn lrm-ack-btn--pending"
            disabled={isAcking}
            onClick={() => onAcknowledge(r.id)}
          >
            <UserCheck size={14} /> {isAcking ? 'Отмечаем…' : 'Ознакомлен'}
          </button>
        ) : (
          // Только просмотр (view без edit): статус виден, отметить нельзя.
          <div className="lrm-hr-ack lrm-hr-ack--pending">Не ознакомлен</div>
        )}
      </div>
    </div>
  );
};
