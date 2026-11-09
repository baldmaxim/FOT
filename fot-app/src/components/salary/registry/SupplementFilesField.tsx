import { useRef, type ChangeEvent, type FC } from 'react';
import { Paperclip } from 'lucide-react';

import type { IPayrollSupplementFile } from '../../../services/payrollRegistryService';
import { SUPPLEMENT_FILE_ACCEPT, SUPPLEMENT_FILES_MAX } from '../../../utils/payrollSupplementFiles';
import formStyles from '../../ui/registry/RegistryFormModal.module.css';
import { SupplementFileList, type ISupplementFileListItem } from './SupplementFileList';
import styles from './SupplementFiles.module.css';

interface ISupplementFilesFieldProps {
  /** Сохранённые файлы, которые остаются у доплаты. */
  kept: readonly IPayrollSupplementFile[];
  /** Выбранные, ещё не сохранённые. */
  staged: readonly File[];
  /** Выбор файлов — проверку и ошибку делает форма. */
  onPick: (files: File[]) => void;
  onRemoveKept: (fileId: number) => void;
  onRemoveStaged: (index: number) => void;
  onOpenKept: (file: IPayrollSupplementFile) => void;
  disabled: boolean;
}

/**
 * Блок «Файлы» формы разовой доплаты: сохранённые (имя — открыть, ✕ — снять) и выбранные (✕ — убрать из выбора),
 * «Прикрепить» — выбор нескольких файлов. Всё применяется по «Сохранить» формы.
 */
export const SupplementFilesField: FC<ISupplementFilesFieldProps> = ({
  kept, staged, onPick, onRemoveKept, onRemoveStaged, onOpenKept, disabled,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const items: ISupplementFileListItem[] = [
    ...kept.map(file => ({
      key: `kept-${file.id}`,
      name: file.file_name,
      size: file.file_size,
      onOpen: () => onOpenKept(file),
      onRemove: () => onRemoveKept(file.id),
    })),
    ...staged.map((file, index) => ({
      key: `staged-${index}-${file.name}-${file.size}`,
      name: file.name,
      size: file.size,
      onRemove: () => onRemoveStaged(index),
    })),
  ];

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    // Тот же файл можно выбрать снова (после ✕) — сбрасываем значение.
    event.target.value = '';
    if (picked.length > 0) onPick(picked);
  };

  return (
    <div className={formStyles.field}>
      <span className={formStyles.label}>Файлы</span>
      {items.length > 0 && <SupplementFileList items={items} disabled={disabled} />}
      {items.length < SUPPLEMENT_FILES_MAX && (
        <button
          type="button"
          className={styles.attach}
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          <Paperclip size={16} aria-hidden="true" />
          Прикрепить
        </button>
      )}
      <input
        ref={inputRef}
        className={styles.input}
        type="file"
        multiple
        accept={SUPPLEMENT_FILE_ACCEPT}
        onChange={handleChange}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
};
