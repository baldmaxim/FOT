import { useEffect, useRef, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';

import type { IWorkScheduleFile } from '../../types/schedule';
import { scheduleService } from '../../services/scheduleService';
import { formatFileSize } from '../../utils/attachmentFormat';
import {
  SCHEDULE_FILE_ACCEPT,
  scheduleFilesQueryKey,
  uploadQueue,
  validateScheduleFiles,
} from '../../utils/scheduleFileQueue';
import { ScheduleFileList } from './ScheduleFileList';
import listStyles from './ScheduleFileList.module.css';
import styles from './ScheduleTemplateFiles.module.css';

interface IScheduleTemplateFilesProps {
  /** null — новый график: файлы копятся в pending и уходят после «Сохранить». */
  scheduleId: string | null;
  /** Выбранные, но ещё не загруженные файлы (новый график или сбой загрузки после создания). */
  pending: readonly File[];
  onPendingChange: (files: File[]) => void;
  /** Ошибка загрузки очереди при «Сохранить». */
  pendingError: string | null;
  /** Идёт сохранение графика — менять файлы нельзя. */
  disabled: boolean;
  /** Идёт загрузка или удаление: окно графика на это время не закрывается. */
  onBusyChange: (busy: boolean) => void;
}

/** Блок «Файлы» в окне графика: у сохранённого графика файл прикрепляется и удаляется сразу. */
export const ScheduleTemplateFiles: FC<IScheduleTemplateFilesProps> = ({
  scheduleId, pending, onPendingChange, pendingError, disabled, onBusyChange,
}) => {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: files = [], isLoading, error: loadError } = useQuery({
    queryKey: scheduleId ? scheduleFilesQueryKey(scheduleId) : ['schedule-files', 'none'],
    queryFn: () => scheduleService.listFiles(scheduleId as string),
    enabled: scheduleId !== null,
    staleTime: 0,
  });

  // Только файлы и число у 📎 — не reloadScheduleData: кэши табеля файлы не трогают.
  const refreshFiles = async (id: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: scheduleFilesQueryKey(id) }),
      queryClient.invalidateQueries({ queryKey: ['schedules', 'templates'] }),
    ]);
  };

  const uploadMutation = useMutation({
    mutationFn: async ({ id, selected }: { id: string; selected: File[] }) => {
      const result = await uploadQueue(selected, file => scheduleService.uploadFile(id, file), () => undefined);
      await refreshFiles(id);
      if (result.error) {
        const rest = result.remaining.slice(1).map(file => `«${file.name}»`);
        throw new Error(rest.length > 0 ? `${result.error} Не загружены также: ${rest.join(', ')}.` : result.error);
      }
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка загрузки файла'),
  });

  const removeMutation = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: IWorkScheduleFile }) => {
      try {
        await scheduleService.removeFile(id, file.id);
      } finally {
        await refreshFiles(id);
      }
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка удаления файла'),
  });

  const busy = uploadMutation.isPending || removeMutation.isPending;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  const handleSelect = (list: FileList | null) => {
    const selected = list ? Array.from(list) : [];
    if (inputRef.current) inputRef.current.value = '';
    if (selected.length === 0) return;
    setError(null);
    const invalid = validateScheduleFiles(selected, files.length + pending.length);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (scheduleId) {
      uploadMutation.mutate({ id: scheduleId, selected });
    } else {
      onPendingChange([...pending, ...selected]);
    }
  };

  const handleRemove = (file: IWorkScheduleFile) => {
    if (!scheduleId || !window.confirm(`Удалить файл «${file.file_name}»?`)) return;
    setError(null);
    removeMutation.mutate({ id: scheduleId, file });
  };

  const locked = disabled || busy;
  const shownError = error ?? pendingError ?? (loadError instanceof Error ? loadError.message : null);

  return (
    <section className={styles.section}>
      <div className={styles.title}>Файлы</div>

      {isLoading && <div className={styles.muted}>Загрузка…</div>}

      {scheduleId && files.length > 0 && (
        <ScheduleFileList scheduleId={scheduleId} files={files} onRemove={handleRemove} disabled={locked} />
      )}

      {pending.length > 0 && (
        <ul className={listStyles.list}>
          {pending.map((file, index) => (
            <li key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className={`${listStyles.item} ${listStyles.itemPending}`}>
              <span className={listStyles.name} title={file.name}>{file.name}</span>
              <span className={listStyles.size}>{formatFileSize(file.size)}</span>
              <button
                type="button"
                className={`${listStyles.iconButton} ${listStyles.iconButtonDanger}`}
                onClick={() => onPendingChange(pending.filter((_item, i) => i !== index))}
                disabled={locked}
                title="Убрать"
                aria-label={`Убрать: ${file.name}`}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.actions}>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={SCHEDULE_FILE_ACCEPT}
          className={styles.input}
          onChange={e => handleSelect(e.target.files)}
          aria-label="Вложить файл"
        />
        <button
          type="button"
          className={styles.attach}
          onClick={() => inputRef.current?.click()}
          disabled={locked}
        >
          <Paperclip size={16} aria-hidden="true" />
          {uploadMutation.isPending ? 'Загрузка…' : 'Вложить файл'}
        </button>
      </div>

      {shownError && <p className={styles.error} role="alert">{shownError}</p>}
    </section>
  );
};
