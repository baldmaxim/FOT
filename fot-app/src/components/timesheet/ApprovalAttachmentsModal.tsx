import { type FC, useMemo, useState } from 'react';
import { X, Paperclip } from 'lucide-react';
import { ModalShell } from '../ui/ModalShell';
import { SearchInput } from '../ui/SearchInput';
import { AttachmentList } from './AttachmentList';
import type { IApprovalAttachment } from '../../services/timesheetApprovalService';
import styles from './ApprovalAttachmentsModal.module.css';
import { createFioMatcher, withFioFallback, type FioSearchMode, type IFioMatcher } from '../../utils/fioSearch';

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

/** Совпадение по ФИО сотрудника, для которого прикреплён файл (не по тому, кто прикрепил). */
const matchesEmployee = (att: IApprovalAttachment, matcher: IFioMatcher, mode: FioSearchMode): boolean => {
  if (att.employees && att.employees.length > 0) {
    return att.employees.some(e => matcher.matches(e.employee_name, mode));
  }
  return matcher.matches(att.employee_name, mode);
};

export const ApprovalAttachmentsModal: FC<IApprovalAttachmentsModalProps> = ({
  attachments,
  loading = false,
  urlLoader,
  onClose,
  onDelete,
  canDelete,
  deletingId = null,
}) => {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matcher = createFioMatcher(search);
    if (!matcher) return attachments;
    return withFioFallback(matcher, mode => attachments.filter(att => matchesEmployee(att, matcher, mode)));
  }, [attachments, search]);

  const countLabel = q
    ? ` (${filtered.length} из ${attachments.length})`
    : attachments.length > 0 ? ` (${attachments.length})` : '';

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
              <Paperclip size={16} /> Вложения{countLabel}
            </span>
            <div className={styles.headerSearch}>
              <SearchInput
                value={search}
                onValueChange={setSearch}
                placeholder="Поиск по ФИО сотрудника…"
              />
            </div>
            <button type="button" className={styles.iconBtn} onClick={requestClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
          <div className={styles.body}>
            <AttachmentList
              attachments={filtered}
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
