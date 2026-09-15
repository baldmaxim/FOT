import { memo, type FC } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { StaffSortDir, StaffSortKey } from '../../services/employeeService';

interface IStaffSortHeaderProps {
  sortKey: StaffSortKey;
  label: string;
  activeKey: StaffSortKey;
  dir: StaffSortDir;
  onSort: (key: StaffSortKey) => void;
  className?: string;
  title?: string;
}

/** Заголовок столбца с сортировкой: повторный клик меняет направление, другой столбец — по возрастанию. */
export const StaffSortHeader: FC<IStaffSortHeaderProps> = memo(({ sortKey, label, activeKey, dir, onSort, className, title }) => {
  const active = sortKey === activeKey;
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  const nextLabel = active && dir === 'asc' ? 'по убыванию' : 'по возрастанию';
  return (
    <th className={className} aria-sort={ariaSort} title={title}>
      <button
        type="button"
        className={`sc-sort-btn${active ? ' is-active' : ''}`}
        onClick={() => onSort(sortKey)}
        aria-label={`${label}: сортировать ${nextLabel}`}
      >
        <span className="sc-sort-label">{label}</span>
        <Icon size={12} aria-hidden="true" className="sc-sort-icon" />
      </button>
    </th>
  );
});
