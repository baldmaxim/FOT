import type { FC } from 'react';
import { X } from 'lucide-react';

import { formatFileSize } from '../../../utils/attachmentFormat';
import styles from './SupplementFiles.module.css';

export interface ISupplementFileListItem {
  key: string;
  name: string;
  size: number;
  /** Передан — имя кнопкой: открыть файл (уже сохранённый). */
  onOpen?: () => void;
  /** Передан — ✕ «Убрать файл». */
  onRemove?: () => void;
}

interface ISupplementFileListProps {
  items: readonly ISupplementFileListItem[];
  disabled?: boolean;
}

/** Строки файлов разовой доплаты: имя (кнопкой — если файл можно открыть), размер, ✕. */
export const SupplementFileList: FC<ISupplementFileListProps> = ({ items, disabled = false }) => (
  <ul className={styles.list}>
    {items.map(item => (
      <li key={item.key} className={styles.item}>
        {item.onOpen ? (
          <button type="button" className={styles.nameButton} onClick={item.onOpen}>{item.name}</button>
        ) : (
          <span className={styles.name}>{item.name}</span>
        )}
        <span className={styles.size}>{formatFileSize(item.size)}</span>
        {item.onRemove && (
          <button
            type="button"
            className={styles.remove}
            onClick={item.onRemove}
            disabled={disabled}
            title="Убрать файл"
            aria-label={`Убрать файл «${item.name}»`}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </li>
    ))}
  </ul>
);
