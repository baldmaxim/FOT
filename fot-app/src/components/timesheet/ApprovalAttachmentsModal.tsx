import { type FC } from 'react';
import { X, Paperclip } from 'lucide-react';
import { ModalShell } from '../ui/ModalShell';
import { AttachmentList } from './AttachmentList';
import type { IApprovalAttachment } from '../../services/timesheetApprovalService';
import styles from './ApprovalAttachmentsModal.module.css';

type Disposition = 'inline' | 'attachment';

interface IApprovalAttachmentsModalProps {
  attachments: IApprovalAttachment[];
  loading?: boolean;
  urlLoader: (att: IApprovalAttachment, disposition: Disposition) => Promise<string>;
  onClose: () => void;
  onDelete?: (documentId: number) => void;
  canDelete?: (att: IApprovalAttachment) => boolean;
  deletingId?: number | null;
}

export const ApprovalAttachmentsModal: FC<IApprovalAttachmentsModalProps> = ({
  attachments,
  loading = false,
  urlLoader,
  onClose,
  onDelete,
  canDelete,
  deletingId = null,
}) => {
  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={styles.overlay}
      containerClassName={styles.container}
      aria-label="Вложения табеля"
    >
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <span className={styles.title}>
              <Paperclip size={16} /> Вложения{attachments.length > 0 ? ` (${attachments.length})` : ''}
            </span>
            <button type="button" className={styles.iconBtn} onClick={requestClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
          <div className={styles.body}>
            <AttachmentList
              attachments={attachments}
              loading={loading}
              urlLoader={urlLoader}
              onDelete={onDelete}
              canDelete={canDelete}
              deletingId={deletingId}
            />
          </div>
        </>
      )}
    </ModalShell>
  );
};
