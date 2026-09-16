import { memo, type FC, type MouseEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from 'lucide-react';
import type { StaffSortDir, StaffSortKey } from '../../services/employeeService';

interface IStaffSortHeaderProps {
  sortKey: StaffSortKey;
  label: string;
  activeKey: StaffSortKey;
  dir: StaffSortDir;
  onSort: (key: StaffSortKey) => void;
  /** Открыть фильтр столбца; anchor — кнопка-воронка (позиция окна). */
  onOpenFilter?: (key: StaffSortKey, anchor: HTMLElement) => void;
  filterActive?: boolean;
  className?: string;
  title?: string;
}

/**
 * Заголовок столбца: сортировка (повторный клик меняет направление, другой столбец —
 * по возрастанию) и воронка фильтра столбца.
 */
export const StaffSortHeader: FC<IStaffSortHeaderProps> = memo(({
  sortKey, label, activeKey, dir, onSort, onOpenFilter, filterActive = false, className, title,
}) => {
  const active = sortKey === activeKey;
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  const nextLabel = active && dir === 'asc' ? 'по убыванию' : 'по возрастанию';
  const handleFilter = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onOpenFilter?.(sortKey, event.currentTarget);
  };
  return (
    <th className={className} aria-sort={ariaSort} title={title}>
      <span className="sc-th-inner">
        <button
          type="button"
          className={`sc-sort-btn${active ? ' is-active' : ''}`}
          onClick={() => onSort(sortKey)}
          aria-label={`${label}: сортировать ${nextLabel}`}
        >
          <span className="sc-sort-label">{label}</span>
          <Icon size={12} aria-hidden="true" className="sc-sort-icon" />
        </button>
        {onOpenFilter && (
          <button
            type="button"
            className={`sc-col-filter-btn${filterActive ? ' is-active' : ''}`}
            onClick={handleFilter}
            aria-label={`Фильтр: ${label}${filterActive ? ' (включён)' : ''}`}
            aria-haspopup="dialog"
            title={filterActive ? 'Фильтр включён' : 'Фильтр'}
          >
            <Filter size={11} aria-hidden="true" />
          </button>
        )}
      </span>
    </th>
  );
});
