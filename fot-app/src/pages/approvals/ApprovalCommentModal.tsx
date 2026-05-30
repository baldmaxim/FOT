import { type FC, useEffect, useRef, useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { ModalShell } from '../../components/ui/ModalShell';

interface IProps {
  open: boolean;
  title: string;
  label: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (comment: string) => void;
}

export const ApprovalCommentModal: FC<IProps> = ({ open, title, label, pending, onClose, onConfirm }) => {
  const [comment, setComment] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => setComment(''));
      const t = window.setTimeout(() => textareaRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  if (!open) return null;

  const trimmed = comment.trim();
  const handleConfirm = () => {
    if (!trimmed || pending) return;
    onConfirm(trimmed);
  };

  return (
    <ModalShell onClose={onClose} overlayClassName="approvals-modal-overlay" containerClassName="approvals-modal">
      {({ requestClose }) => (
        <>
          <div className="approvals-modal-header">
            <h3>{title}</h3>
            <button type="button" className="approvals-modal-close" onClick={requestClose} disabled={pending}>
              <X size={18} />
            </button>
          </div>
          <div className="approvals-modal-body">
            <label htmlFor="approval-comment" className="approvals-modal-label">{label}</label>
            <textarea
              id="approval-comment"
              ref={textareaRef}
              className="approvals-modal-textarea"
              value={comment}
              onChange={e => setComment(e.target.value)}
              disabled={pending}
              rows={4}
              placeholder="Опишите, что нужно поправить…"
            />
          </div>
          <div className="approvals-modal-footer">
            <button
              type="button"
              className="approvals-modal-cancel"
              onClick={requestClose}
              disabled={pending}
            >
              Отмена
            </button>
            <button
              type="button"
              className="approvals-action-btn approvals-action-btn--rework"
              onClick={handleConfirm}
              disabled={pending || !trimmed}
            >
              <RotateCcw size={16} />
              {pending ? 'Отправка…' : 'На доработку'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
