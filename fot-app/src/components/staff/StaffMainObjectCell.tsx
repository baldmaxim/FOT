import { type FC } from 'react';

interface IStaffMainObjectCellProps {
  /** undefined — данные ещё грузятся; null/'' — значения нет. */
  name: string | null | undefined;
  /** Порция данных не загрузилась: приглушённое «—» с подсказкой вместо вечного скелетона. */
  failed?: boolean;
}

/** Ячейка «Объект»: скелетон до загрузки, затем название в одну строку. */
export const StaffMainObjectCell: FC<IStaffMainObjectCellProps> = ({ name, failed = false }) => {
  if (failed) return <span className="sc-muted" title="Не удалось загрузить">—</span>;
  if (name === undefined) return <span className="sc-skeleton" aria-label="Загрузка" />;
  if (!name) return <span className="sc-muted">—</span>;
  return <span className="sc-ellipsis" title={name}>{name}</span>;
};
