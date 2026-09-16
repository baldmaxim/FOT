import { memo, type FC, type MouseEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from 'lucide-react';

import type { PayrollSortDir, PayrollSortKey } from '../../services/payrollService';
import styles from './PayrollSortHeader.module.css';

interface IPayrollSortHeaderProps {
  sortKey: PayrollSortKey;
  label: string;
  activeKey: PayrollSortKey;
  dir: PayrollSortDir;
  onSort: (key: PayrollSortKey) => void;
  /** Открыть фильтр столбца; anchor — кнопка-воронка (позиция окна). */
  onOpenFilter: (key: PayrollSortKey, anchor: HTMLElement) => void;
  filterActive: boolean;
  className?: string;
}

/**
 * Заголовок столбца условий оплаты — как в «Текущих сотрудниках»: сортировка (повторный клик
 * меняет направление, другой столбец — по возрастанию) и воронка фильтра столбца.
 */
export const PayrollSortHeader: FC<IPayrollSortHeaderProps> = memo(({
  sortKey, label, activeKey, dir, onSort, onOpenFilter, filterActive, className,
}) => {
  const active = sortKey === activeKey;
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  const nextLabel = active && dir === 'asc' ? 'по убыванию' : 'по возрастанию';

  const handleFilter = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onOpenFilter(sortKey, event.currentTarget);
  };

  return (
    <th className={className} aria-sort={ariaSort}>
      <span className={styles.inner}>
        <button
          type="button"
          className={`${styles.sortButton}${active ? ` ${styles.sortActive}` : ''}`}
          onClick={() => onSort(sortKey)}
          aria-label={`${label}: сортировать ${nextLabel}`}
        >
          <span className={styles.label}>{label}</span>
          <Icon size={12} aria-hidden="true" className={styles.sortIcon} />
        </button>
        <button
          type="button"
          className={`${styles.filterButton}${filterActive ? ` ${styles.filterActive}` : ''}`}
          onClick={handleFilter}
          aria-label={`Фильтр: ${label}${filterActive ? ' (включён)' : ''}`}
          aria-haspopup="dialog"
          title={filterActive ? 'Фильтр включён' : 'Фильтр'}
        >
          <Filter size={11} aria-hidden="true" />
        </button>
      </span>
    </th>
  );
});

PayrollSortHeader.displayName = 'PayrollSortHeader';
