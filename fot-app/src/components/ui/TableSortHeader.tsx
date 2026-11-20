import type { DragEvent, KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from 'lucide-react';

import styles from './TableSortHeader.module.css';

interface ITableSortHeaderProps<K extends string> {
  sortKey: K;
  label: string;
  activeKey: string;
  dir: 'asc' | 'desc';
  onSort: (key: K) => void;
  /** Открыть фильтр столбца; anchor — кнопка-воронка (позиция окна). */
  onOpenFilter: (key: K, anchor: HTMLElement) => void;
  filterActive: boolean;
  className?: string;
  /** Подсказка заголовка. */
  title?: string;
  /** Сортировка и фильтр недоступны (данные столбца ещё считаются). */
  disabled?: boolean;
  /** Рядом с воронкой, в строке подписи («+» раскрытия столбца). */
  extra?: ReactNode;
  /** Под подписью (период сумм). */
  children?: ReactNode;
  /**
   * Передан — столбец переставляется: заголовок тянется мышью (draggable задаёт вызывающий — только на точном
   * указателе), Alt+← / Alt+→ на кнопке сортировки — на соседнее место. over — сюда бросят (полоса слева или справа).
   */
  reorder?: {
    draggable: boolean;
    over: 'before' | 'after' | null;
    onDragStart: (event: DragEvent<HTMLTableCellElement>) => void;
    onDragOver: (event: DragEvent<HTMLTableCellElement>) => void;
    onDragLeave: () => void;
    onDrop: (event: DragEvent<HTMLTableCellElement>) => void;
    onDragEnd: () => void;
    onMoveBy: (delta: -1 | 1) => void;
  };
}

/**
 * Заголовок столбца как в «Текущих сотрудниках»: сортировка (повторный клик меняет
 * направление, другой столбец — по возрастанию) и воронка фильтра столбца.
 */
export const TableSortHeader = <K extends string>({
  sortKey, label, activeKey, dir, onSort, onOpenFilter, filterActive, className, title, disabled = false, extra, children,
  reorder,
}: ITableSortHeaderProps<K>): ReactElement => {
  const active = sortKey === activeKey;
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  const nextLabel = active && dir === 'asc' ? 'по убыванию' : 'по возрастанию';

  const handleFilter = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onOpenFilter(sortKey, event.currentTarget);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!reorder || !event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    reorder.onMoveBy(event.key === 'ArrowLeft' ? -1 : 1);
  };

  const thClass = [
    className,
    reorder?.draggable ? styles.draggable : null,
    reorder?.over === 'before' ? styles.dropBefore : null,
    reorder?.over === 'after' ? styles.dropAfter : null,
  ].filter(Boolean).join(' ');

  return (
    <th
      className={thClass || undefined}
      aria-sort={ariaSort}
      title={title}
      {...(reorder?.draggable ? {
        draggable: true,
        onDragStart: reorder.onDragStart,
        onDragOver: reorder.onDragOver,
        onDragLeave: reorder.onDragLeave,
        onDrop: reorder.onDrop,
        onDragEnd: reorder.onDragEnd,
      } : {})}
    >
      <span className={styles.inner}>
        <button
          type="button"
          className={`${styles.sortButton}${active ? ` ${styles.sortActive}` : ''}`}
          onClick={() => onSort(sortKey)}
          onKeyDown={reorder ? handleKeyDown : undefined}
          disabled={disabled}
          aria-label={`${label}: сортировать ${nextLabel}${reorder ? '; Alt+стрелка — переставить столбец' : ''}`}
        >
          <span className={styles.label}>{label}</span>
          <Icon size={12} aria-hidden="true" className={styles.sortIcon} />
        </button>
        <button
          type="button"
          className={`${styles.filterButton}${filterActive ? ` ${styles.filterActive}` : ''}`}
          onClick={handleFilter}
          disabled={disabled}
          aria-label={`Фильтр: ${label}${filterActive ? ' (включён)' : ''}`}
          aria-haspopup="dialog"
          title={filterActive ? 'Фильтр включён' : 'Фильтр'}
        >
          <Filter size={11} aria-hidden="true" />
        </button>
        {extra}
      </span>
      {children}
    </th>
  );
};
