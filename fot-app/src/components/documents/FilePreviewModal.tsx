import { type FC, useCallback, useEffect, useState } from 'react';
import { X, Download } from 'lucide-react';
import { documentService } from '../../services/documentService';
import { ModalShell } from '../ui/ModalShell';
import styles from './FilePreviewModal.module.css';

type Disposition = 'inline' | 'attachment';

interface IFilePreviewModalProps {
  documentId?: number;
  fileName: string;
  mimeType?: string | null;
  onClose: () => void;
  /**
   * Альтернативный источник signed URL. Если задан — используется он;
   * иначе берётся documentService.getDownloadUrl(documentId).
   * disposition='inline' — для предпросмотра, 'attachment' — для скачивания.
   */
  urlLoader?: (disposition: Disposition) => Promise<string>;
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

  const loadUrl = useCallback(
    (disposition: Disposition): Promise<string> => {
      if (urlLoader) return urlLoader(disposition);
      if (documentId != null) {
        return documentService.getDownloadUrl(documentId, disposition).then(r => r.download_url);
      }
      return Promise.reject(new Error('Не указан источник файла'));
    },
    [documentId, urlLoader],
  );

  useEffect(() => {
    let active = true;
    loadUrl('inline')
      .then(u => { if (active) setUrl(u); })
      .catch(() => { if (active) setError('Не удалось получить ссылку на файл'); });
    return () => { active = false; };
  }, [loadUrl]);

  const handleDownload = useCallback(async () => {
    try {
      const u = await loadUrl('attachment');
      const a = document.createElement('a');
      a.href = u;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setError('Не удалось скачать файл');
    }
  }, [loadUrl, fileName]);

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
                <button type="button" className={styles.iconBtn} onClick={handleDownload} title="Скачать">
                  <Download size={16} />
                </button>
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
                <button type="button" className={styles.downloadBtn} onClick={handleDownload}>
                  <Download size={14} /> Скачать
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
};
