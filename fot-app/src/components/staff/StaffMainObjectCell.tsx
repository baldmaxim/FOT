import { type FC } from 'react';

interface IStaffMainObjectCellProps {
  /** undefined — данные ещё грузятся; null/'' — объекта за период нет. */
  name: string | null | undefined;
}

/** Ячейка «Объект»: скелетон до загрузки, затем название в одну строку. */
export const StaffMainObjectCell: FC<IStaffMainObjectCellProps> = ({ name }) => {
  if (name === undefined) return <span className="sc-skeleton" aria-label="Загрузка" />;
  if (!name) return <span className="sc-muted">—</span>;
  return <span className="sc-ellipsis" title={name}>{name}</span>;
};
