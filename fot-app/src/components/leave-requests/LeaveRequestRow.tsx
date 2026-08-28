import { type FC, type MouseEvent as ReactMouseEvent } from 'react';
import { Ban, Check, ChevronDown, ChevronUp, Clock, Paperclip, X } from 'lucide-react';
import {
  REQUEST_TYPE_LABELS,
  CORRECTION_STATUS_LABELS,
  formatCorrectionHours,
  getRequestDecision,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
} from '../../services/leaveRequestService';
import { LeaveRequestHistory } from './LeaveRequestHistory';
import { LeaveRequestSkudEvents } from './LeaveRequestSkudEvents';
import { TriStateCheckbox } from '../ui/TriStateCheckbox';
import {
  formatLeaveRequestDateCell,
  formatLeaveRequestDatesCompact,
  leaveRequestMinDate,
} from '../../utils/leaveRequestDates';
import { formatDateTimeShort, formatHM } from '../../utils/dateCompact';
import { displayFileName } from '../../utils/fileNameDisplay';
import { formatFioShort } from '../../utils/formatFio';

// Типы «отпусков», для которых доступна управленческая отмена согласованного.
const VACATION_TYPES = new Set(['vacation', 'unpaid', 'educational_leave']);

// Подписи типов в узкой колонке «Формат»: полные варианты из REQUEST_TYPE_LABELS
// туда не помещаются рядом со вторым бейджем.
const SHORT_TYPE_LABELS: Record<string, string> = {
  time_correction: 'Корректировка',
  work: 'Работа в выходной',
  educational_leave: 'Учебный отпуск',
  sick_worked: 'Работа на больничном',
  dismissal: 'Увольнение',
};

const typeLabel = (type: string): string =>
  SHORT_TYPE_LABELS[type] ?? REQUEST_TYPE_LABELS[type] ?? type;

const stop = (e: ReactMouseEvent) => e.stopPropagation();

export interface ILeaveRequestRowProps {
  request: ILeaveRequest;
  isAdmin: boolean;
  currentUserId?: string;
  canEditRequests: boolean;
  /** «Сегодня» в Europe/Moscow — для отмены только будущих отпусков. */
  todayIso: string;
  /** Идёт массовая операция: чекбокс и действия строки заблокированы. */
  actionsDisabled: boolean;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  expanded: boolean;
  onToggleExpanded: (id: number) => void;
  /** Показывать статус у pending — нужно только на вкладке «Все», где статусы смешаны. */
  showPendingStatus: boolean;
  /** Решение по одной строке (галочка/крестик); показываются только у selectable. */
  onApprove?: (id: number) => void;
  onReject?: (id: number) => void;
  onOpenAttachment: (attachment: ILeaveRequestAttachment) => void;

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

/**
 * Строка заявления в списке согласования. Вид и плотность — как у строки
 * выходного дня на /approvals: решения принимаются только массово (чекбокс +
 * панель сверху), детали живут в раскрытии.
 */
export const LeaveRequestRow: FC<ILeaveRequestRowProps> = ({
  request: r,
  isAdmin,
  currentUserId,
  canEditRequests,
  todayIso,
  actionsDisabled,
  selectable,
  selected,
  onToggleSelect,
  expanded,
  onToggleExpanded,
  showPendingStatus,
  onApprove,
  onReject,
  onOpenAttachment,
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
  const decision = getRequestDecision(r);
  const isCorrection = r.request_type === 'time_correction';
  const awaitingApproval = (isCorrection || r.request_type === 'work')
    && r.correction_approval_status === 'pending';
  // Решение по согласованному заявлению откатывает только тот, кто его принял, — или админ.
  const canManageApproved = r.status === 'approved' && (isAdmin || currentUserId === r.reviewer_id);
  // Отпуск руководитель отменяет только до его начала (у админа ограничения нет);
  // для остальных типов сдерживает гард закрытого табеля на бэке.
  const canRevoke = canManageApproved
    && (!VACATION_TYPES.has(r.request_type) || isAdmin || leaveRequestMinDate(r) > todayIso);
  // Часы правит согласующий до решения; после — только принявший решение.
  const canEditHours = canEditRequests && (r.status === 'pending' || canManageApproved);
  const dateCell = formatLeaveRequestDateCell(r);
  const hours = r.correction_hours != null ? formatHM(Number(r.correction_hours)) : '—';
  const reason = (r.reason ?? '').trim();
  const attachments = r.attachments ?? [];
  const detailsId = `lrm-details-${r.id}`;

  const hasSkudEvents = isCorrection && !!r.correction_date;
  // Часы правятся прямо из строки только когда есть что править: у корректировки,
  // с правом и с заданным значением (иначе null ушёл бы в редактор как «0»).
  const canEditHoursInline = isCorrection && canEditHours && r.correction_hours != null;

  // Клик по строке (любой тип) раскрывает детали; проходы СКУД у корректировки
  // живут в раскрытии справа. Роль и табстоп на <li> не вешаем: внутри живут
  // чекбокс и кнопки, а интерактив внутри role="button" ломает клавиатуру и
  // скринридеры. Клавиатурный путь — шеврон справа.
  const handleRowClick = () => onToggleExpanded(r.id);

  const startHoursEdit = () => {
    onStartEditHours(r.id, r.correction_hours as number | string);
    if (!expanded) onToggleExpanded(r.id);
  };

  return (
    <li
      className={`lrm-item${expanded ? ' lrm-item--expanded' : ''}`}
      onClick={handleRowClick}
    >
      <div className="lrm-item-grid">
        {selectable ? (
          <span className="lrm-item-check" onClick={stop}>
            <TriStateCheckbox
              state={selected ? 'all' : 'none'}
              onChange={() => onToggleSelect(r.id)}
              ariaLabel={`Выбрать заявление ${r.employee_name || r.employee_id}`}
              disabled={actionsDisabled}
            />
          </span>
        ) : (
          <span className="lrm-item-check lrm-item-check--empty" aria-hidden="true" />
        )}

        <span className="lrm-item-date" data-hours={hours}>
          <span className="lrm-item-date-day">{dateCell.day}</span>
          {dateCell.sub && <span className="lrm-item-date-sub">{dateCell.sub}</span>}
        </span>

        <span className="lrm-item-employee">
          <span className="lrm-item-employee-name">{r.employee_name || `#${r.employee_id}`}</span>
          {r.position_name && <span className="lrm-item-position">{r.position_name}</span>}
        </span>

        <div className="lrm-item-task">
          <span className="lrm-item-task-caption">Формат</span>
          <span className="lrm-item-badges">
            <span className={`lrm-item-status lrm-item-status--${r.request_type}`}>
              {typeLabel(r.request_type)}
            </span>
            {isCorrection && r.correction_status && (
              <span className="lrm-item-substatus">
                {CORRECTION_STATUS_LABELS[r.correction_status] ?? r.correction_status}
              </span>
            )}
          </span>
        </div>

        {canEditHoursInline ? (
          <button
            type="button"
            className="lrm-item-hours lrm-item-hours-edit-btn"
            disabled={actionsDisabled}
            title="Изменить часы"
            onClick={(e) => { e.stopPropagation(); startHoursEdit(); }}
          >
            {hours}
          </button>
        ) : (
          <span className="lrm-item-hours">{hours}</span>
        )}

        <div
          className={`lrm-item-notes${reason ? '' : ' lrm-item-notes--empty'}${expanded ? ' lrm-item-notes--expanded' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleExpanded(r.id); }}
        >
          <span className="lrm-item-notes-caption">Задача</span>
          {reason
            ? <span className="lrm-item-notes-text">{reason}</span>
            : <span className="lrm-item-notes-placeholder">Без комментария</span>}
          {awaitingApproval && (
            <span className="lrm-item-awaiting">
              <Clock size={11} /> Ожидает согласования
            </span>
          )}
          {(r.status !== 'pending' || showPendingStatus) && (
            <span className={`lrm-item-decision lrm-item-decision--${r.status}`}>
              {r.status === 'pending'
                ? <Clock size={11} />
                : (r.status === 'approved' ? <Check size={11} /> : <X size={11} />)}
              <span className="lrm-item-decision-label">{decision.label}</span>
              {decision.actor && <span className="lrm-item-decision-by">{formatFioShort(decision.actor)}</span>}
              {decision.at && <span className="lrm-item-decision-at">· {formatDateTimeShort(decision.at)}</span>}
            </span>
          )}
        </div>

        <div className="lrm-item-actions" onClick={stop}>
          {selectable && onApprove && onReject && (
            <>
              <button
                type="button"
                className="lrm-item-icon-btn lrm-item-decide lrm-item-decide--approve"
                data-tip="Согласовать"
                aria-label="Согласовать"
                disabled={actionsDisabled}
                onClick={() => onApprove(r.id)}
              >
                <Check size={15} />
              </button>
              <button
                type="button"
                className="lrm-item-icon-btn lrm-item-decide lrm-item-decide--reject"
                data-tip="Отклонить"
                aria-label="Отклонить"
                disabled={actionsDisabled}
                onClick={() => onReject(r.id)}
              >
                <X size={15} />
              </button>
            </>
          )}
          {attachments.length > 0 && (
            <span className="lrm-item-attach" title={`Вложений: ${attachments.length}`}>
              <Paperclip size={13} />
              {attachments.length > 1 && <span>{attachments.length}</span>}
            </span>
          )}
          {canRevoke && (
            <button
              type="button"
              className="lrm-item-icon-btn"
              disabled={actionsDisabled}
              title={VACATION_TYPES.has(r.request_type) ? 'Отменить согласованный отпуск' : 'Отменить согласование'}
              aria-label="Отменить согласование"
              onClick={() => { onStartRevoke(r.id); if (!expanded) onToggleExpanded(r.id); }}
            >
              <Ban size={14} />
            </button>
          )}
          <button
            type="button"
            className="lrm-item-icon-btn"
            onClick={() => onToggleExpanded(r.id)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={expanded ? 'Свернуть детали' : 'Показать детали'}
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div
          className={`lrm-item-details${hasSkudEvents ? ' lrm-item-details--with-side' : ''}`}
          id={detailsId}
          onClick={stop}
        >
          <div className="lrm-details-main">
            <div className="lrm-details-row">
              <span className="lrm-details-label">Даты</span>
              <span className="lrm-details-value">{formatLeaveRequestDatesCompact(r)}</span>
            </div>
            {r.department_name && (
              <div className="lrm-details-row">
                <span className="lrm-details-label">Отдел</span>
                <span className="lrm-details-value">{r.department_name}</span>
              </div>
            )}
            {r.correction_hours != null && (
              <div className="lrm-details-row">
                <span className="lrm-details-label">Часы</span>
                <span className="lrm-details-value">
                  {editingHoursId === r.id ? (
                    <span className="lrm-hours-edit">
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
                        className="lrm-details-btn"
                        disabled={savingHours}
                        onClick={() => onSaveHours(r.id)}
                      >
                        Сохранить
                      </button>
                      <button
                        type="button"
                        className="lrm-details-btn lrm-details-btn--ghost"
                        disabled={savingHours}
                        onClick={onCancelEditHours}
                      >
                        Отмена
                      </button>
                    </span>
                  ) : (canEditHours ? (
                    <button
                      type="button"
                      className="lrm-hours-btn"
                      disabled={actionsDisabled}
                      onClick={startHoursEdit}
                      title="Изменить часы"
                    >
                      {formatCorrectionHours(r.correction_hours)}ч
                    </button>
                  ) : `${formatCorrectionHours(r.correction_hours)}ч`)}
                </span>
              </div>
            )}
            {reason && (
              <div className="lrm-details-row">
                <span className="lrm-details-label">Причина</span>
                <span className="lrm-details-value lrm-details-value--text">{reason}</span>
              </div>
            )}
            {decision.comment && (
              <div className="lrm-details-row">
                <span className="lrm-details-label">
                  {r.status === 'cancelled' ? 'Причина отмены' : 'Комментарий'}
                </span>
                <span className="lrm-details-value lrm-details-value--text">{decision.comment}</span>
              </div>
            )}
            {r.hr_acknowledged_at && (
              <div className="lrm-details-row">
                <span className="lrm-details-label">Отдел кадров</span>
                <span className="lrm-details-value">
                  <Check size={13} /> Ознакомлен
                </span>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="lrm-details-row">
                <span className="lrm-details-label">Файлы</span>
                <span className="lrm-details-value lrm-attachments">
                  {attachments.map(att => (
                    <button
                      key={att.id}
                      type="button"
                      className="lrm-attachment-btn"
                      onClick={() => onOpenAttachment(att)}
                      title={att.file_name}
                    >
                      <Paperclip size={12} />
                      <span className="lrm-attachment-name">{displayFileName(att.file_name)}</span>
                    </button>
                  ))}
                </span>
              </div>
            )}

            <LeaveRequestHistory requestId={r.id} />

            {canRevoke && (
              revokeId === r.id ? (
                <div className="lrm-revoke-form">
                  <div className="lrm-revoke-confirm">
                    {VACATION_TYPES.has(r.request_type) ? 'Отменить согласованный отпуск?' : 'Отменить согласование заявления?'}
                  </div>
                  <input
                    className="lrm-revoke-input"
                    placeholder="Причина (необязательно)"
                    value={revokeReason}
                    onChange={e => onRevokeReasonChange(e.target.value)}
                    onKeyDown={e => e.stopPropagation()}
                  />
                  <div className="lrm-revoke-btns">
                    <button
                      type="button"
                      className="lrm-details-btn lrm-details-btn--danger"
                      disabled={revoking}
                      onClick={() => onRevoke(r.id)}
                    >
                      <Ban size={14} /> {revoking
                        ? 'Отменяем…'
                        : (VACATION_TYPES.has(r.request_type) ? 'Отменить отпуск' : 'Отменить согласование')}
                    </button>
                    <button
                      type="button"
                      className="lrm-details-btn lrm-details-btn--ghost"
                      disabled={revoking}
                      onClick={onCancelRevoke}
                    >
                      Назад
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="lrm-details-btn lrm-details-btn--danger"
                  disabled={actionsDisabled}
                  onClick={() => onStartRevoke(r.id)}
                >
                  <Ban size={14} /> {VACATION_TYPES.has(r.request_type) ? 'Отменить согласованное' : 'Отменить согласование'}
                </button>
              )
            )}
          </div>

          {hasSkudEvents && r.correction_date && (
            <div className="lrm-details-side">
              <LeaveRequestSkudEvents employeeId={r.employee_id} date={r.correction_date} />
            </div>
          )}
        </div>
      )}
    </li>
  );
};
