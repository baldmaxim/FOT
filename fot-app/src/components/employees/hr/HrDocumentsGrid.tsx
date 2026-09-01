import { useRef, useState, type FC } from 'react';
import { Download, Eye, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { FilePreviewModal } from '../../documents/FilePreviewModal';
import { hrProfileService } from '../../../services/hrProfileService';
import type { IHrDocument, IHrDocumentSlot } from '../../../types/hrProfile';
import { fmtBytes, fmtDateTime } from './hrFormat';
import styles from './HrProfileModal.module.css';

interface IHrDocumentsGridProps {
  slots: IHrDocumentSlot[];
  canEdit: boolean;
  uploading: string | null;
  onUpload: (typeCode: string, file: File) => void;
  onDelete: (doc: IHrDocument) => void;
  onRecognize: (doc: IHrDocument) => void;
  /** Просмотр/скачивание доступны только с правом edit (PII). */
  canView: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'в очереди',
  processing: 'распознаётся…',
  done: 'распознано',
  failed: 'не распозналось',
  needs_review: 'нужна проверка',
};

const statusClass = (s: IHrDocument['recognition_status']): string => {
  if (s === 'done') return styles.stOk;
  if (s === 'failed') return styles.stErr;
  if (s === 'needs_review') return styles.stWarn;
  if (s === 'pending' || s === 'processing') return styles.stBusy;
  return '';
};

/** Сетка слотов по типам документов (как панель «Документы» в PassDesk). */
export const HrDocumentsGrid: FC<IHrDocumentsGridProps> = ({ slots, canEdit, uploading, onUpload, onDelete, onRecognize, canView }) => {
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [preview, setPreview] = useState<IHrDocument | null>(null);

  const download = async (doc: IHrDocument) => {
    const url = await hrProfileService.documentBlobUrl(doc.id, 'attachment');
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className={styles.docsGrid}>
      {slots.map(slot => (
        <div key={slot.code} className={`${styles.slot} ${slot.required && slot.files.length === 0 ? styles.slotMissing : ''}`}>
          <div className={styles.slotHead}>
            <span className={styles.slotTitle}>
              {slot.label}
              {slot.required && <span className={styles.req} title="Обязательный документ">*</span>}
            </span>
            <span className={styles.slotCount}>{slot.files.length}</span>
          </div>
          {slot.files.map(doc => (
            <div key={doc.id} className={styles.docRow}>
              <div className={styles.docMain}>
                <span className={styles.docName} title={doc.file_name}>{doc.file_name}</span>
                <span className={styles.docMeta}>
                  {fmtBytes(doc.file_size)} · {fmtDateTime(doc.created_at)}
                  {doc.ocr_supported && doc.recognition_status && (
                    <span className={`${styles.docStatus} ${statusClass(doc.recognition_status)}`} title={doc.recognition_error ?? undefined}>
                      {(doc.recognition_status === 'pending' || doc.recognition_status === 'processing') && <Loader2 size={11} className={styles.spin} />}
                      {STATUS_LABEL[doc.recognition_status] ?? doc.recognition_status}
                    </span>
                  )}
                </span>
              </div>
              <div className={styles.docActions}>
                {canView && <button type="button" className={styles.iconBtn} title="Просмотр" onClick={() => setPreview(doc)}><Eye size={15} /></button>}
                {canView && <button type="button" className={styles.iconBtn} title="Скачать" onClick={() => void download(doc)}><Download size={15} /></button>}
                {canEdit && doc.ocr_supported && (
                  <button type="button" className={styles.iconBtn} title="Распознать повторно" onClick={() => onRecognize(doc)} disabled={doc.recognition_status === 'processing'}><RefreshCw size={15} /></button>
                )}
                {canEdit && <button type="button" className={`${styles.iconBtn} ${styles.iconDanger}`} title="Удалить" onClick={() => onDelete(doc)}><Trash2 size={15} /></button>}
              </div>
            </div>
          ))}
          {canEdit && (
            <>
              <input
                ref={el => { inputs.current[slot.code] = el; }}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                hidden
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(slot.code, f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className={styles.uploadBtn}
                onClick={() => inputs.current[slot.code]?.click()}
                disabled={uploading === slot.code}
              >
                {uploading === slot.code ? <Loader2 size={14} className={styles.spin} /> : <Upload size={14} />}
                {uploading === slot.code ? 'Загрузка…' : 'Загрузить'}
              </button>
            </>
          )}
        </div>
      ))}
      {preview && (
        <FilePreviewModal
          fileName={preview.file_name}
          mimeType={preview.mime_type}
          onClose={() => setPreview(null)}
          urlLoader={disposition => hrProfileService.documentBlobUrl(preview.id, disposition)}
        />
      )}
    </div>
  );
};
