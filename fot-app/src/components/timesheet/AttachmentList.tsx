import { type FC, useState } from 'react';
import { FileText, Eye, Trash2 } from 'lucide-react';
import { FilePreviewModal } from '../documents/FilePreviewModal';
import { displayFileName } from '../../utils/fileNameDisplay';
import { formatFileSize, formatDateRanges } from '../../utils/attachmentFormat';
import type { IApprovalAttachment } from '../../services/timesheetApprovalService';
import styles from './AttachmentList.module.css';

type Disposition = 'inline' | 'attachment';

interface IAttachmentListProps {
  attachments: IApprovalAttachment[];
  /** Источник signed URL для предпросмотра/скачивания файла. */
  urlLoader: (att: IApprovalAttachment, disposition: Disposition) => Promise<string>;
  loading?: boolean;
  /** Удаление: кнопка показывается, если заданы onDelete и canDelete(att) === true. */
  onDelete?: (documentId: number) => void;
  canDelete?: (att: IApprovalAttachment) => boolean;
  deletingId?: number | null;
  /** Разбивать на блоки «Руководитель»/«Сотрудники» по is_submitter_file. По умолчанию true. */
  grouped?: boolean;
}

const subjectLabel = (att: IApprovalAttachment): string | null => {
  if (att.employees && att.employees.length > 1) return 'Несколько сотрудников';
  return att.employee_name ?? null;
};

const subjectTitle = (att: IApprovalAttachment): string | undefined => {
  if (att.employees && att.employees.length > 1) {
    return att.employees
      .map(e => [e.employee_name, e.employee_position].filter(Boolean).join(' — '))
      .join('\n');
  }
  return undefined;
};

const AttachmentRow: FC<{
  att: IApprovalAttachment;
  onPreview: () => void;
  onDelete?: (documentId: number) => void;
  canDelete: boolean;
  deleting: boolean;
}> = ({ att, onPreview, onDelete, canDelete, deleting }) => {
  const subject = subjectLabel(att);
  const showUploader =
    !!att.uploaded_by_name && (!subject || (att.employees?.length ?? 0) > 1 || att.uploaded_by_name !== att.employee_name);
  const dates = formatDateRanges(att.work_dates);

  return (
    <li className={styles.row}>
      <FileText size={16} className={styles.fileIcon} />
      <div className={styles.info}>
        <div className={styles.nameLine}>
          <span className={styles.name} title={att.file_name}>{displayFileName(att.file_name)}</span>
          <span className={styles.size}>{formatFileSize(att.file_size)}</span>
        </div>
        <div className={styles.metaLine}>
          {att.reason_label && <span className={styles.badge}>{att.reason_label}</span>}
          {dates && <span className={styles.dates}>{dates}</span>}
        </div>
        {subject && (
          <div className={styles.metaLine} title={subjectTitle(att)}>
            <span className={styles.metaKey}>Сотрудник:</span>
            <span className={styles.metaVal}>
              {subject}
              {att.employee_position && (att.employees?.length ?? 0) <= 1 ? `, ${att.employee_position}` : ''}
            </span>
          </div>
        )}
        {showUploader && (
          <div className={styles.metaLine}>
            <span className={styles.metaKey}>Прикрепил:</span>
            <span className={styles.metaVal}>
              {att.uploaded_by_name}
              {att.uploader_position ? `, ${att.uploader_position}` : ''}
            </span>
          </div>
        )}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.iconBtn} onClick={onPreview} title="Открыть файл" aria-label="Открыть файл">
          <Eye size={16} />
        </button>
        {canDelete && onDelete && (
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            onClick={() => onDelete(att.document_id)}
            disabled={deleting}
            title="Удалить файл"
            aria-label="Удалить файл"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </li>
  );
};

export const AttachmentList: FC<IAttachmentListProps> = ({
  attachments,
  urlLoader,
  loading = false,
  onDelete,
  canDelete,
  deletingId = null,
  grouped = true,
}) => {
  const [preview, setPreview] = useState<IApprovalAttachment | null>(null);

  if (loading) return <div className={styles.empty}>Загрузка…</div>;
  if (attachments.length === 0) return <div className={styles.empty}>Файлов нет</div>;

  const submitterFiles = attachments.filter(a => a.is_submitter_file);
  const otherFiles = attachments.filter(a => !a.is_submitter_file);
  const showHeaders = grouped && submitterFiles.length > 0 && otherFiles.length > 0;

  const renderList = (items: IApprovalAttachment[]) => (
    <ul className={styles.list}>
      {items.map(att => (
        <AttachmentRow
          key={att.document_id}
          att={att}
          onPreview={() => setPreview(att)}
          onDelete={onDelete}
          canDelete={Boolean(canDelete?.(att))}
          deleting={deletingId === att.document_id}
        />
      ))}
    </ul>
  );

  return (
    <div className={styles.container}>
      {showHeaders ? (
        <>
          <div className={styles.groupHeader}>Руководитель</div>
          {renderList(submitterFiles)}
          <div className={styles.groupHeader}>Сотрудники</div>
          {renderList(otherFiles)}
        </>
      ) : (
        renderList(attachments)
      )}

      {preview && (
        <FilePreviewModal
          documentId={preview.document_id}
          fileName={preview.file_name}
          mimeType={preview.mime_type}
          urlLoader={(d) => urlLoader(preview, d)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
};
