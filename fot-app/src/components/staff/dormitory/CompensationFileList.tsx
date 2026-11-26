import { useCallback, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { Download, Eye, X } from 'lucide-react';

import { dormitoryService, type ICompensationFile } from '../../../services/dormitoryService';
import { formatFileSize } from '../../../utils/attachmentFormat';
import styles from '../../admin/ScheduleFileList.module.css';
import { FilePreviewModal } from '../../documents/FilePreviewModal';

interface ICompensationFileListProps {
  employeeId: number;
  files: readonly ICompensationFile[];
  /** Передан — у строки ✕ «Удалить» (окно ✎); без него — только просмотр и скачивание (📎 в таблице). */
  onRemove?: (file: ICompensationFile) => void;
  disabled?: boolean;
  /** Открыт ли просмотр файла: окно-родитель на это время не закрывается по Escape. */
  onPreviewChange?: (open: boolean) => void;
}

/**
 * Файлы компенсации аренды сотрудника (миграция 380): имя, размер, 👁 «Просмотр», ⬇ «Скачать», ✕ (если можно
 * удалять). Ссылка — по клику, на 5 минут. Вид — как у файлов шаблонов графиков (ScheduleFileList).
 */
export const CompensationFileList: FC<ICompensationFileListProps> = ({
  employeeId, files, onRemove, disabled = false, onPreviewChange,
}) => {
  const [preview, setPreview] = useState<ICompensationFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Стабильный загрузчик: новый на каждый рендер заново запрашивал бы ссылку и перезагружал открытый файл.
  const previewId = preview?.id ?? null;
  const loadPreviewUrl = useCallback(
    (disposition: 'inline' | 'attachment'): Promise<string> => (previewId === null
      ? Promise.reject(new Error('Файл не выбран'))
      : dormitoryService.getCompensationFileUrl(employeeId, previewId, disposition)),
    [employeeId, previewId],
  );

  const openPreview = (file: ICompensationFile) => {
    setError(null);
    setPreview(file);
    onPreviewChange?.(true);
  };

  const closePreview = () => {
    setPreview(null);
    onPreviewChange?.(false);
  };

  // R2 отдаёт файл с Content-Disposition: attachment и исходным именем.
  const download = async (file: ICompensationFile) => {
    setError(null);
    try {
      const url = await dormitoryService.getCompensationFileUrl(employeeId, file.id, 'attachment');
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
