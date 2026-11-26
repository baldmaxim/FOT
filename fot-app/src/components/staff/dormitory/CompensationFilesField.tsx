import { useEffect, useRef, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';

import {
  compensationFilesKey,
  DORMITORY_COMPENSATION_KEY,
  dormitoryService,
  type ICompensationFile,
} from '../../../services/dormitoryService';
import { formatFileSize } from '../../../utils/attachmentFormat';
import { COMPENSATION_FILES_MAX, validateCompensationFiles } from '../../../utils/compensationFiles';
import { SCHEDULE_FILE_ACCEPT, uploadQueue } from '../../../utils/scheduleFileQueue';
import listStyles from '../../admin/ScheduleFileList.module.css';
import styles from '../../admin/ScheduleTemplateFiles.module.css';
import { CompensationFileList } from './CompensationFileList';

interface ICompensationFilesFieldProps {
  /** null — сотрудник ещё не сохранён («Добавить сотрудника»): файлы копятся в pending и уходят после «Сохранить». */
  employeeId: number | null;
  /** Выбранные, но ещё не загруженные файлы (новая запись или сбой загрузки после записи). */
  pending: readonly File[];
  onPendingChange: (files: File[]) => void;
  /** Ошибка загрузки очереди при «Сохранить». */
  pendingError: string | null;
  /** Идёт сохранение записи — менять файлы нельзя. */
  disabled: boolean;
  /** Идёт загрузка или удаление: окно на это время не закрывается. */
  onBusyChange: (busy: boolean) => void;
  /** Открыт просмотр файла: окно не закрывается по Escape. */
  onPreviewChange: (open: boolean) => void;
}

/**
 * Блок «Файлы» в окне «Компенсации аренды» (миграция 380): у сохранённого сотрудника файл прикрепляется и удаляется
 * сразу, при «Добавить сотрудника» — после записи. Файлы — у сотрудника: не теряются при паузе и возобновлении.
 */
export const CompensationFilesField: FC<ICompensationFilesFieldProps> = ({
  employeeId, pending, onPendingChange, pendingError, disabled, onBusyChange, onPreviewChange,
}) => {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: files = [], isLoading, error: loadError } = useQuery({
    queryKey: employeeId !== null ? compensationFilesKey(employeeId) : ['compensation-files', 'none'],
    queryFn: ({ signal }) => dormitoryService.listCompensationFiles(employeeId as number, signal),
    enabled: employeeId !== null,
    staleTime: 0,
  });

  // Список файлов и 📎N в таблице месяца.
  const refreshFiles = async (id: number) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: compensationFilesKey(id) }),
      queryClient.invalidateQueries({ queryKey: DORMITORY_COMPENSATION_KEY }),
    ]);
  };

  const uploadMutation = useMutation({
    mutationFn: async ({ id, selected }: { id: number; selected: File[] }) => {
      const result = await uploadQueue(selected, file => dormitoryService.uploadCompensationFile(id, file), () => undefined);
      await refreshFiles(id);
      if (result.error) {
        const rest = result.remaining.slice(1).map(file => `«${file.name}»`);
        throw new Error(rest.length > 0 ? `${result.error} Не загружены также: ${rest.join(', ')}.` : result.error);
      }
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка загрузки файла'),
  });

  const removeMutation = useMutation({
    mutationFn: async ({ id, file }: { id: number; file: ICompensationFile }) => {
      try {
        await dormitoryService.removeCompensationFile(id, file.id);
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
    const invalid = validateCompensationFiles(selected, files.length + pending.length);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (employeeId !== null && pending.length === 0) {
      uploadMutation.mutate({ id: employeeId, selected });
    } else {
      onPendingChange([...pending, ...selected]);
    }
  };

  const handleRemove = (file: ICompensationFile) => {
    if (employeeId === null || !window.confirm(`Удалить файл «${file.file_name}»?`)) return;
    setError(null);
    removeMutation.mutate({ id: employeeId, file });
  };

  const locked = disabled || busy;
  const shownError = error ?? pendingError ?? (loadError instanceof Error ? loadError.message : null);

  return (
    <section className={styles.section}>
      <div className={styles.title}>Файлы</div>

      {isLoading && <div className={styles.muted}>Загрузка…</div>}

      {employeeId !== null && files.length > 0 && (
        <CompensationFileList
          employeeId={employeeId}
          files={files}
          onRemove={handleRemove}
          disabled={locked}
          onPreviewChange={onPreviewChange}
        />
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
          disabled={locked || files.length + pending.length >= COMPENSATION_FILES_MAX}
        >
          <Paperclip size={16} aria-hidden="true" />
          {uploadMutation.isPending ? 'Загрузка…' : 'Вложить файл'}
        </button>
      </div>

      {shownError && <p className={styles.error} role="alert">{shownError}</p>}
    </section>
  );
};
