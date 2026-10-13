import { type FC, useCallback } from 'react';
import { documentService } from '../../services/documentService';
import { ModalShell } from '../ui/ModalShell';
import { FileViewer, type FileDisposition } from './FileViewer';
import styles from './FilePreviewModal.module.css';

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
  urlLoader?: (disposition: FileDisposition) => Promise<string>;
}

/** Просмотр файла отдельным окном: оболочка модалки вокруг общего [FileViewer]. */
export const FilePreviewModal: FC<IFilePreviewModalProps> = ({
  documentId,
  fileName,
  mimeType,
  onClose,
  urlLoader,
}) => {
  const loadUrl = useCallback(
    (disposition: FileDisposition): Promise<string> => {
      if (urlLoader) return urlLoader(disposition);
      if (documentId != null) {
        return documentService.getDownloadUrl(documentId, disposition).then(r => r.download_url);
      }
      return Promise.reject(new Error('Не указан источник файла'));
    },
    [documentId, urlLoader],
  );

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container}>
      {({ requestClose }) => (
        <FileViewer fileName={fileName} mimeType={mimeType} loadUrl={loadUrl} onClose={requestClose} safeAreaTop />
      )}
    </ModalShell>
  );
};
