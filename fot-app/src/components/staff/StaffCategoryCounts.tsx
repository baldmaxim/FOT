import { type FC } from 'react';
import type { IStaffCategoryCounts } from '../../services/employeeService';

interface IStaffCategoryCountsProps {
  counts: IStaffCategoryCounts;
  className?: string;
}

/** «ИТР 558 · Рабочие 578 · Остальные 13» — разбивка числа таблицы. */
export const StaffCategoryCounts: FC<IStaffCategoryCountsProps> = ({ counts, className }) => (
  <span className={className ? `sc-category-counts ${className}` : 'sc-category-counts'}>
    ИТР {counts.itr} · Рабочие {counts.worker} · Остальные {counts.other}
  </span>
);
