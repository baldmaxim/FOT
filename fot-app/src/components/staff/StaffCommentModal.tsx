import { useState, type FC } from 'react';
import { Check } from 'lucide-react';
import { ApiError } from '../../api/client';
import { employeeService, type IStaffCommentCurrent, type IStaffCommentSaved } from '../../services/employeeService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { Employee } from '../../types';
import { describeStaffCommentMeta, STAFF_COMMENT_MAX_LENGTH } from './staffComment';

const STAFF_COMMENT_CONFLICT_CODE = 'STAFF_COMMENT_CONFLICT';

interface IStaffCommentModalProps {
  employee: Employee;
  onClose: () => void;
  /** Сохранено (или без изменений): канонические значения с сервера. */
  onSaved: (employee: Employee, saved: IStaffCommentSaved) => void;
}

interface IServerVersion {
  comment: string;
  updatedAt: string | null;
  author: string | null;
}

/**
 * Комментарий HR. Версия — то, что пользователь видел: если комментарий успели поменять,
 * сервер отвечает 409; введённый текст остаётся, версия становится серверной — повторное
 * «Сохранить» перезапишет осознанно.
 */
export const StaffCommentModal: FC<IStaffCommentModalProps> = ({ employee, onClose, onSaved }) => {
  const toast = useToast();
  const [server, setServer] = useState<IServerVersion>(() => ({
    comment: employee.staff_comment ?? '',
    updatedAt: employee.staff_comment_updated_at ?? null,
    author: employee.staff_comment_updated_by_name ?? null,
  }));
  const [text, setText] = useState(employee.staff_comment ?? '');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const dismiss = useOverlayDismiss(busy ? () => undefined : onClose);

  const trimmed = text.trim();
  const tooLong = trimmed.length > STAFF_COMMENT_MAX_LENGTH;
  const unchanged = trimmed === server.comment;
  const meta = describeStaffCommentMeta(server.author, server.updatedAt);

  const save = async (): Promise<void> => {
    setBusy(true);
    setConflict(null);
    try {
      const saved = await employeeService.saveStaffComment(employee.id, trimmed, server.updatedAt);
      onSaved(employee, saved);
      if (!saved.changed) toast.info('Без изменений');
      else toast.success(saved.comment ? 'Комментарий сохранён' : 'Комментарий удалён');
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === STAFF_COMMENT_CONFLICT_CODE) {
        const current = (error.details?.data as { current?: IStaffCommentCurrent | null } | undefined)?.current ?? null;
        setServer({
          comment: current?.comment ?? '',
          updatedAt: current?.updated_at ?? null,
          author: current?.updated_by_name ?? null,
        });
        setConflict(current
          ? `Комментарий уже изменил ${current.updated_by_name || 'другой пользователь'}. Сейчас: «${current.comment}». Ваш текст сохранён в поле — проверьте и сохраните ещё раз.`
          : 'Комментарий уже удалил другой пользователь. Ваш текст сохранён в поле — проверьте и сохраните ещё раз.');
      } else {
        toast.error(error instanceof Error && error.message ? error.message : 'Не удалось сохранить комментарий');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sc-overlay" {...dismiss}>
      <div
        className="sc-modal sc-modal--comment"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-comment-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="sc-modal-header">
          <h3 id="staff-comment-title">Комментарий — {employee.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose} disabled={busy} aria-label="Закрыть">&times;</button>
        </div>
        <div className="sc-modal-body">
          {conflict && <div className="sc-cost-item-conflict" role="alert">{conflict}</div>}
          <div className="sc-field">
            <label htmlFor="staff-comment-text">Комментарий о сотруднике</label>
            <textarea
              id="staff-comment-text"
              className="sc-comment-textarea"
              value={text}
              onChange={event => setText(event.target.value)}
              rows={6}
              maxLength={STAFF_COMMENT_MAX_LENGTH + 200}
              disabled={busy}
              autoFocus
            />
            <div className={`sc-comment-counter${tooLong ? ' is-over' : ''}`} aria-live="polite">
              {trimmed.length} / {STAFF_COMMENT_MAX_LENGTH}
            </div>
          </div>
          <div className="sc-comment-modal-meta">
            {meta ? `Последнее изменение: ${meta}` : 'Комментария пока нет'}
            {trimmed === '' && server.comment !== '' && ' · пустое поле удалит комментарий'}
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="sc-btn apply" onClick={() => { void save(); }} disabled={busy || tooLong || unchanged}>
            <Check size={15} aria-hidden="true" />
            {busy ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};
