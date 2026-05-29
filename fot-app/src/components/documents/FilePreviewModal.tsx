import { type FC, useEffect, useState } from 'react';
import { X, Download } from 'lucide-react';
import { documentService } from '../../services/documentService';
import { ModalShell } from '../ui/ModalShell';
import styles from './FilePreviewModal.module.css';

interface IFilePreviewModalProps {
  documentId?: number;
  fileName: string;
  mimeType?: string | null;
  onClose: () => void;
  /**
   * Альтернативный источник signed URL. Если задан — используется он;
   * иначе берётся documentService.getDownloadUrl(documentId).
   */
  urlLoader?: () => Promise<string>;
}

export const FilePreviewModal: FC<IFilePreviewModalProps> = ({
  documentId,
  fileName,
  mimeType,
  onClose,
  urlLoader,
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loader = urlLoader
      ? urlLoader()
      : documentId != null
        ? documentService.getDownloadUrl(documentId).then(r => r.download_url)
        : Promise.reject(new Error('Не указан источник файла'));
    loader
      .then(u => { if (active) setUrl(u); })
      .catch(() => { if (active) setError('Не удалось получить ссылку на файл'); });
    return () => { active = false; };
  }, [documentId, urlLoader]);

  const isImage = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container}>
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <span className={styles.title} title={fileName}>{fileName}</span>
            <div className={styles.actions}>
              {url && (
                <a className={styles.iconBtn} href={url} download={fileName} title="Скачать">
                  <Download size={16} />
                </a>
              )}
              <button type="button" className={styles.iconBtn} onClick={requestClose} aria-label="Закрыть">
                <X size={18} />
              </button>
            </div>
          </div>
          <div className={styles.body}>
            {error && <div className={styles.error}>{error}</div>}
            {!error && !url && <div className={styles.loading}>Загрузка…</div>}
            {url && !error && isImage && (
              <img src={url} alt={fileName} className={styles.image} />
            )}
            {url && !error && isPdf && (
              <iframe src={url} title={fileName} className={styles.iframe} />
            )}
            {url && !error && !isImage && !isPdf && (
              <div className={styles.fallback}>
                <div>Предпросмотр недоступен для этого типа файла.</div>
                <a className={styles.downloadBtn} href={url} download={fileName}>
                  <Download size={14} /> Скачать
                </a>
              </div>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
};
