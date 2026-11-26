import { useId, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { compensationFilesKey, dormitoryService } from '../../../services/dormitoryService';
import styles from '../../admin/ScheduleFilesModal.module.css';
import { ModalShell } from '../../ui/ModalShell';
import formStyles from '../../ui/registry/RegistryFormModal.module.css';
import { CompensationFileList } from './CompensationFileList';

interface ICompensationFilesModalProps {
  employeeId: number;
  fullName: string;
  onClose: () => void;
}

/** «Файлы» из 📎 в таблице «Компенсации аренды» (миграция 380): только просмотр и скачивание. */
export const CompensationFilesModal: FC<ICompensationFilesModalProps> = ({ employeeId, fullName, onClose }) => {
  const titleId = useId();
  const [previewOpen, setPreviewOpen] = useState(false);

  const { data: files = [], isLoading, error } = useQuery({
    queryKey: compensationFilesKey(employeeId),
    queryFn: ({ signal }) => dormitoryService.listCompensationFiles(employeeId, signal),
    staleTime: 0,
  });

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={formStyles.overlay}
      containerClassName={formStyles.container}
      // Поверх открыт просмотр файла: Escape закрывает только его.
      closeOnEscape={!previewOpen}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={formStyles.header}>
            <h2 id={titleId} className={formStyles.title}>Файлы — {fullName}</h2>
            <button type="button" className={formStyles.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>
          <div className={formStyles.body}>
            {isLoading && <div className={styles.muted}>Загрузка…</div>}
            {error instanceof Error && <p className={styles.error} role="alert">{error.message}</p>}
            {!isLoading && !error && files.length === 0 && <div className={styles.muted}>Файлов нет</div>}
            {files.length > 0 && (
              <CompensationFileList employeeId={employeeId} files={files} onPreviewChange={setPreviewOpen} />
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
};
