import { type FC } from 'react';
import { MapPin } from 'lucide-react';

interface IProps {
  objects: Array<{ id: string; name: string }>;
  /** Объекты, назначенные отделу/бригаде сотрудника. */
  deptObjectIds: string[];
  /** Персональные объекты сотрудника (переопределяют объекты бригады). */
  empObjectIds: string[];
  onEdit: () => void;
}

/**
 * Ячейка столбца «Объект» на «Управление кадрами». Показывает эффективное
 * назначение (персональное переопределяет бригадное) + кнопку открытия модалки.
 */
export const StaffObjectCell: FC<IProps> = ({ objects, deptObjectIds, empObjectIds, onEdit }) => {
  const isPersonal = empObjectIds.length > 0;
  const effectiveIds = isPersonal ? empObjectIds : deptObjectIds;
  const nameById = new Map(objects.map(o => [o.id, o.name]));
  const names = effectiveIds.map(id => nameById.get(id)).filter((v): v is string => Boolean(v));
  const text = names.length > 0 ? names.join(', ') : '—';

  return (
    <span className="sc-cell-with-btn">
      <button className="sc-inline-btn" title="Назначить объект" onClick={e => { e.stopPropagation(); onEdit(); }}>
        <MapPin size={12} />
      </button>
      <span className="sc-obj-names" title={text}>
        {text}
        {isPersonal && names.length > 0 && (
          <span className="sc-obj-badge" title="Персональное назначение">перс.</span>
        )}
      </span>
    </span>
  );
};
