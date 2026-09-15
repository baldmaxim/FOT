import { type FC } from 'react';
import { Pencil } from 'lucide-react';
import type { Employee } from '../../types';
import { StaffMainObjectCell } from './StaffMainObjectCell';

interface IStaffCostItemCellProps {
  employee: Employee;
  /** undefined — ещё грузится; null/'' — значения нет. */
  name: string | null | undefined;
  /** Порция данных не загрузилась. */
  failed?: boolean;
  /** Нет — только просмотр (нет права на режим табелирования или не «Действующие»). */
  onEdit?: (employee: Employee) => void;
}

/** «Статья затрат»: текст, а при праве — кнопка, открывающая выбор режима табелирования. */
export const StaffCostItemCell: FC<IStaffCostItemCellProps> = ({ employee, name, failed = false, onEdit }) => {
  if (!onEdit || failed || name === undefined) return <StaffMainObjectCell name={name} failed={failed} />;
  return (
    <button
      type="button"
      className="sc-cell-edit"
      title={name ? `${name} — изменить` : 'Изменить статью затрат'}
      aria-label={`Изменить статью затрат: ${employee.full_name}`}
      onClick={event => { event.stopPropagation(); onEdit(employee); }}
    >
      <span className="sc-ellipsis">{name || '—'}</span>
      <Pencil size={12} aria-hidden="true" className="sc-cell-edit-icon" />
    </button>
  );
};
