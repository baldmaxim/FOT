import { useId, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import type { IWorkSchedule } from '../../types/schedule';
import { scheduleService } from '../../services/scheduleService';
import { scheduleFilesQueryKey } from '../../utils/scheduleFileQueue';
import { ModalShell } from '../ui/ModalShell';
import formStyles from '../ui/registry/RegistryFormModal.module.css';
import { ScheduleFileList } from './ScheduleFileList';
import styles from './ScheduleFilesModal.module.css';

interface IScheduleFilesModalProps {
  schedule: IWorkSchedule;
  onClose: () => void;
}

/** «Файлы графика» из 📎 в таблице шаблонов: только просмотр и скачивание, график не правится. */
export const ScheduleFilesModal: FC<IScheduleFilesModalProps> = ({ schedule, onClose }) => {
  const titleId = useId();
  const [previewOpen, setPreviewOpen] = useState(false);

  const { data: files = [], isLoading, error } = useQuery({
    queryKey: scheduleFilesQueryKey(schedule.id),
    queryFn: () => scheduleService.listFiles(schedule.id),
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
            <h2 id={titleId} className={formStyles.title}>Файлы графика — {schedule.name}</h2>
            <button type="button" className={formStyles.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>
          <div className={formStyles.body}>
            {isLoading && <div className={styles.muted}>Загрузка…</div>}
            {error instanceof Error && <p className={styles.error} role="alert">{error.message}</p>}
            {!isLoading && !error && files.length === 0 && <div className={styles.muted}>Файлов нет</div>}
            {files.length > 0 && (
              <ScheduleFileList scheduleId={schedule.id} files={files} onPreviewChange={setPreviewOpen} />
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
};
