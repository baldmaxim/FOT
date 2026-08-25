import { type FC, type MouseEvent as ReactMouseEvent } from 'react';
import { Check, X, Clock, CheckCircle, XCircle, Ban, Paperclip } from 'lucide-react';
import {
  REQUEST_TYPE_LABELS,
  CORRECTION_STATUS_LABELS,
  formatCorrectionHours,
  getRequestDecision,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import { LeaveRequestHistory } from './LeaveRequestHistory';
import { TriStateCheckbox } from '../ui/TriStateCheckbox';
import { formatLeaveRequestDatesCompact, leaveRequestMinDate } from '../../utils/leaveRequestDates';
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

// Типы «отпусков», для которых доступна управленческая отмена согласованного.
const VACATION_TYPES = new Set(['vacation', 'unpaid', 'educational_leave']);

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

const stop = (e: ReactMouseEvent) => e.stopPropagation();

export interface ILeaveRequestCardProps {
  request: ILeaveRequest;
  isAdmin: boolean;
  currentUserId?: string;
  canEditRequests: boolean;
  /** «Сегодня» в Europe/Moscow — для отмены только будущих отпусков. */
  todayIso: string;
  /** Идёт массовая операция: одиночные действия и чекбокс заблокированы. */
  actionsDisabled: boolean;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  /** Открыта ли панель событий именно по этой корректировке. */
  isEventsActive: boolean;
  onOpenEvents: (request: ILeaveRequest) => void;
  onOpenAttachment: (attachment: ILeaveRequestAttachment) => void;

  commentOpenId: number | null;
  comment: string;
  onCommentChange: (value: string) => void;
  onStartReject: (id: number) => void;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;

  editingHoursId: number | null;
  hoursDraft: string;
  savingHours: boolean;
  onStartEditHours: (id: number, hours: number | string) => void;
  onHoursDraftChange: (value: string) => void;
  onSaveHours: (id: number) => void;
  onCancelEditHours: () => void;

  revokeId: number | null;
  revokeReason: string;
  revoking: boolean;
  onStartRevoke: (id: number) => void;
  onRevokeReasonChange: (value: string) => void;
  onRevoke: (id: number) => void;
  onCancelRevoke: () => void;
}

export const LeaveRequestCard: FC<ILeaveRequestCardProps> = ({
  request: r,
  isAdmin,
  currentUserId,
  canEditRequests,
  todayIso,
  actionsDisabled,
  selectable,
  selected,
  onToggleSelect,
  isEventsActive,
  onOpenEvents,
  onOpenAttachment,
  commentOpenId,
  comment,
  onCommentChange,
  onStartReject,
  onApprove,
  onReject,
  editingHoursId,
  hoursDraft,
  savingHours,
  onStartEditHours,
  onHoursDraftChange,
  onSaveHours,
  onCancelEditHours,
  revokeId,
  revokeReason,
  revoking,
  onStartRevoke,
  onRevokeReasonChange,
  onRevoke,
  onCancelRevoke,
}) => {
  const Icon = STATUS_ICONS[r.status];
  const decision = getRequestDecision(r);
  const isCorrection = r.request_type === 'time_correction' && !!r.correction_date;
  const awaitingApproval = (isCorrection || r.request_type === 'work')
    && r.correction_approval_status === 'pending';
  // Решение по согласованному заявлению откатывает только тот, кто его принял, — или админ.
  const canManageApproved = r.status === 'approved' && (isAdmin || currentUserId === r.reviewer_id);
  // Часы правит согласующий до решения; после — только принявший решение и только
  // пока период не сдан в табеле (окончательную проверку делает бэк).
  const canEditHours = canEditRequests && (r.status === 'pending' || canManageApproved);

  return (
    <div className="lrm-card-row">
      {selectable && (
        <TriStateCheckbox
          className="lrm-card-check"
          state={selected ? 'all' : 'none'}
          onChange={() => onToggleSelect(r.id)}
          ariaLabel={`Выбрать заявление ${r.employee_name || r.employee_id}`}
          disabled={actionsDisabled}
        />
      )}
      <div
        className={`lrm-card${isCorrection ? ' lrm-card--clickable' : ''}${isEventsActive ? ' lrm-card--active' : ''}`}
        onClick={isCorrection ? () => onOpenEvents(r) : undefined}
        role={isCorrection ? 'button' : undefined}
        tabIndex={isCorrection ? 0 : undefined}
        onKeyDown={isCorrection ? (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenEvents(r);
          }
        } : undefined}
      >
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
              {r.hr_acknowledged_at && (
                <div className="lrm-hr-ack" title="Отдел кадров ознакомлен">
                  <CheckCircle size={13} /> Отдел кадров ознакомлен
                </div>
              )}
            </div>
          </div>
          {awaitingApproval && (
            <div className="lrm-card-pending-admin" style={{ color: '#f59e0b' }}>
              <Clock size={12} /> <strong>Ожидает согласования</strong>
            </div>
          )}
          <div className="lrm-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>
          {r.request_type === 'time_correction' && r.correction_date ? (
            <div className="lrm-card-dates">
              <strong>Дата: {formatDate(r.correction_date)}</strong>
              {' · '}
              <strong>
                Статус: {r.correction_status
                  ? (CORRECTION_STATUS_LABELS[r.correction_status] ?? r.correction_status)
                  : '—'}
              </strong>
              {r.correction_hours != null && (
                editingHoursId === r.id ? (
                  <span className="lrm-hours-edit" onClick={stop}>
                    {' · '}
                    <input
                      type="number"
                      className="lrm-hours-input"
                      value={hoursDraft}
                      onChange={(e) => onHoursDraftChange(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') { e.preventDefault(); onSaveHours(r.id); }
                        if (e.key === 'Escape') { e.preventDefault(); onCancelEditHours(); }
                      }}
                      step="0.5"
                      min="0"
                      max="24"
                      inputMode="decimal"
                      disabled={savingHours}
                      autoFocus
                    />
                    <span className="lrm-hours-unit">ч</span>
                    <button
                      type="button"
                      className="lrm-action-btn approve"
                      disabled={savingHours}
                      onClick={(e) => { e.stopPropagation(); onSaveHours(r.id); }}
                    >
                      Сохранить
                    </button>
                    <button
                      type="button"
                      className="lrm-action-btn ghost"
                      disabled={savingHours}
                      onClick={(e) => { e.stopPropagation(); onCancelEditHours(); }}
                    >
                      Отмена
                    </button>
                  </span>
                ) : (canEditHours ? (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="lrm-hours-btn"
                      disabled={actionsDisabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartEditHours(r.id, r.correction_hours as number | string);
                      }}
                      title="Изменить часы"
                    >
                      {formatCorrectionHours(r.correction_hours)}ч
                    </button>
                  </>
                ) : ` · ${formatCorrectionHours(r.correction_hours)}ч`)
              )}
            </div>
          ) : (
            <div className="lrm-card-dates">
              <strong>{formatLeaveRequestDatesCompact(r)}</strong>
            </div>
          )}
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
          <LeaveRequestHistory requestId={r.id} />
        </div>

        {r.status === 'pending' && (
          <div className="lrm-card-actions" onClick={stop}>
            {commentOpenId === r.id ? (
              <div className="lrm-comment-form">
                <input
                  className="lrm-comment-input"
                  placeholder="Комментарий (необязательно)"
                  value={comment}
                  onChange={e => onCommentChange(e.target.value)}
                  onClick={stop}
                  onKeyDown={e => e.stopPropagation()}
                  disabled={actionsDisabled}
                />
                <div className="lrm-comment-btns">
                  <button
                    className="lrm-action-btn approve"
                    disabled={actionsDisabled}
                    onClick={(e) => { e.stopPropagation(); onApprove(r.id); }}
                  >
                    <Check size={14} /> Согласовать
                  </button>
                  <button
                    className="lrm-action-btn reject"
                    disabled={actionsDisabled}
                    onClick={(e) => { e.stopPropagation(); onReject(r.id); }}
                  >
                    <X size={14} /> Не согласовать
                  </button>
                </div>
              </div>
            ) : (
              <div className="lrm-action-row">
                <button
                  className="lrm-action-btn approve"
                  disabled={actionsDisabled}
                  onClick={(e) => { e.stopPropagation(); onApprove(r.id); }}
                >
                  <Check size={14} /> Согласовать
                </button>
                <button
                  className="lrm-action-btn reject"
                  disabled={actionsDisabled}
                  onClick={(e) => { e.stopPropagation(); onStartReject(r.id); }}
                >
                  <X size={14} /> Не согласовать
                </button>
              </div>
            )}
          </div>
        )}

        {canManageApproved
          // Отпуск руководитель отменяет только до его начала (у админа ограничения нет);
          // для остальных типов сдерживает гард закрытого табеля на бэке.
          && (!VACATION_TYPES.has(r.request_type) || isAdmin || leaveRequestMinDate(r) > todayIso) && (
          <div className="lrm-card-actions" onClick={stop}>
            {revokeId === r.id ? (
              <div className="lrm-comment-form">
                <div className="lrm-revoke-confirm">
                  {VACATION_TYPES.has(r.request_type) ? 'Отменить согласованный отпуск?' : 'Отменить согласование заявления?'}
                </div>
                <input
                  className="lrm-comment-input"
                  placeholder="Причина (необязательно)"
                  value={revokeReason}
                  onChange={e => onRevokeReasonChange(e.target.value)}
                  onClick={stop}
                  onKeyDown={e => e.stopPropagation()}
                />
                <div className="lrm-comment-btns">
                  <button
                    className="lrm-action-btn reject"
                    disabled={revoking}
                    onClick={(e) => { e.stopPropagation(); onRevoke(r.id); }}
                  >
                    <Ban size={14} /> {revoking
                      ? 'Отменяем…'
                      : (VACATION_TYPES.has(r.request_type) ? 'Отменить отпуск' : 'Отменить согласование')}
                  </button>
                  <button
                    className="lrm-action-btn ghost"
                    disabled={revoking}
                    onClick={(e) => { e.stopPropagation(); onCancelRevoke(); }}
                  >
                    Назад
                  </button>
                </div>
              </div>
            ) : (
              <div className="lrm-action-row lrm-action-row--right">
                <button
                  className="lrm-action-btn revoke"
                  disabled={actionsDisabled}
                  onClick={(e) => { e.stopPropagation(); onStartRevoke(r.id); }}
                >
                  <Ban size={14} /> {VACATION_TYPES.has(r.request_type) ? 'Отменить согласованное' : 'Отменить согласование'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
