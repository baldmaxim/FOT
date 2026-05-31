import { type FC } from 'react';
import { MapPin } from 'lucide-react';
import { objectGroupLabelsForIds, type IAddressObject } from '../../utils/objectGroups';

interface IProps {
  objects: IAddressObject[];
  /** Объекты, назначенные отделу/бригаде сотрудника. */
  deptObjectIds: string[];
  /** Персональные объекты сотрудника (переопределяют объекты бригады). */
  empObjectIds: string[];
  onEdit: () => void;
}

/**
 * Ячейка столбца «Объект» на «Управление кадрами». Показывает эффективное
 * назначение по адресу (персональное переопределяет бригадное; объекты с одним
 * адресом схлопнуты) + кнопку открытия модалки.
 */
export const StaffObjectCell: FC<IProps> = ({ objects, deptObjectIds, empObjectIds, onEdit }) => {
  const isPersonal = empObjectIds.length > 0;
  const effectiveIds = isPersonal ? empObjectIds : deptObjectIds;
  const labels = objectGroupLabelsForIds(objects, effectiveIds);
  const text = labels.length > 0 ? labels.join(', ') : '—';

  return (
    <span className="sc-cell-with-btn">
      <button className="sc-inline-btn" title="Назначить объект" onClick={e => { e.stopPropagation(); onEdit(); }}>
        <MapPin size={12} />
      </button>
      <span className="sc-obj-names" title={text}>
        {text}
        {isPersonal && labels.length > 0 && (
          <span className="sc-obj-badge" title="Персональное назначение">перс.</span>
        )}
      </span>
    </span>
  );
};
