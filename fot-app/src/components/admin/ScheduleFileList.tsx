import { useCallback, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { Download, Eye, X } from 'lucide-react';

import type { IWorkScheduleFile } from '../../types/schedule';
import { scheduleService } from '../../services/scheduleService';
import { FilePreviewModal } from '../documents/FilePreviewModal';
import { formatFileSize } from '../../utils/attachmentFormat';
import styles from './ScheduleFileList.module.css';

interface IScheduleFileListProps {
  scheduleId: string;
  files: readonly IWorkScheduleFile[];
  /** Передан — у строки ✕ «Удалить» (окно графика); без него — только просмотр и скачивание. */
  onRemove?: (file: IWorkScheduleFile) => void;
  disabled?: boolean;
  /** Открыт ли просмотр файла: окно-родитель на это время не закрывается по Escape. */
  onPreviewChange?: (open: boolean) => void;
}

/** Файлы шаблона графика: имя, размер, 👁 «Просмотр», ⬇ «Скачать», ✕ (если можно удалять). */
export const ScheduleFileList: FC<IScheduleFileListProps> = ({
  scheduleId, files, onRemove, disabled = false, onPreviewChange,
}) => {
  const [preview, setPreview] = useState<IWorkScheduleFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Стабильный загрузчик: новый на каждый рендер заново запрашивал бы ссылку и перезагружал открытый файл.
  const previewId = preview?.id ?? null;
  const loadPreviewUrl = useCallback(
    (disposition: 'inline' | 'attachment'): Promise<string> => (previewId === null
      ? Promise.reject(new Error('Файл не выбран'))
      : scheduleService.getFileUrl(scheduleId, previewId, disposition)),
    [scheduleId, previewId],
  );

  const openPreview = (file: IWorkScheduleFile) => {
    setError(null);
    setPreview(file);
    onPreviewChange?.(true);
  };

  const closePreview = () => {
    setPreview(null);
    onPreviewChange?.(false);
  };

  // Ссылка — по клику (5 минут); R2 отдаёт файл с Content-Disposition: attachment и исходным именем.
  const download = async (file: IWorkScheduleFile) => {
    setError(null);
    try {
      const url = await scheduleService.getFileUrl(scheduleId, file.id, 'attachment');
      const link = document.createElement('a');
      link.href = url;
      link.download = file.file_name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось скачать файл');
    }
  };

  return (
    <>
      <ul className={styles.list}>
        {files.map(file => (
          <li key={file.id} className={styles.item}>
            <span className={styles.name} title={file.file_name}>{file.file_name}</span>
            <span className={styles.size}>{formatFileSize(file.file_size)}</span>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => openPreview(file)}
              title="Просмотр"
              aria-label={`Просмотр: ${file.file_name}`}
            >
              <Eye size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => { void download(file); }}
              title="Скачать"
              aria-label={`Скачать: ${file.file_name}`}
            >
              <Download size={16} aria-hidden="true" />
            </button>
            {onRemove && (
              <button
                type="button"
                className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                onClick={() => onRemove(file)}
                disabled={disabled}
                title="Удалить"
                aria-label={`Удалить: ${file.file_name}`}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className={styles.error} role="alert">{error}</p>}

      {/* Портал: окна-родители (ModalShell) масштабируются transform — fixed внутри них съехал бы. */}
      {preview && createPortal(
        <FilePreviewModal
          fileName={preview.file_name}
          mimeType={preview.mime_type}
          urlLoader={loadPreviewUrl}
          onClose={closePreview}
        />,
        document.body,
      )}
    </>
  );
};
