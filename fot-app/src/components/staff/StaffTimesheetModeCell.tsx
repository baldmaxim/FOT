import { type FC } from 'react';
import { CalendarCog } from 'lucide-react';
import type { ITimesheetModeEmployee } from '../../services/adminService';

interface IProps {
  row: ITimesheetModeEmployee | undefined;
  canEdit: boolean;
  onEdit: () => void;
}

const MODE_LABELS: Record<string, string> = {
  current_activity: 'Текущая деятельность',
  object: 'Объект',
  skud: 'СКУД',
};

/**
 * Ячейка «Режим табелирования» на «Управление кадрами». Показывает эффективный режим
 * для выгрузки «Единый файл для 1С».
 *
 * Пометка источника строго по `source`: «насл.» ставится ТОЛЬКО для department_explicit.
 * Правило «source ≠ employee_explicit → насл.» было бы ошибкой — legacy-режим часто
 * приходит из персонального назначения объекта, а не от отдела.
 */
export const StaffTimesheetModeCell: FC<IProps> = ({ row, canEdit, onEdit }) => {
  // Данные могли не приехать (запрос ещё идёт или упал). Кнопку всё равно показываем:
  // иначе режим невозможно открыть, а модалка умеет работать и без предзагруженной строки.
  if (!row) {
    return (
      <span className="sc-cell-with-btn">
        {canEdit && (
          <button
            className="sc-inline-btn"
            title="Режим табелирования для 1С"
            onClick={e => { e.stopPropagation(); onEdit(); }}
          >
            <CalendarCog size={12} />
          </button>
        )}
        <span className="sc-obj-names">—</span>
      </span>
    );
  }

  const label = MODE_LABELS[row.effective_mode] ?? row.effective_mode;
  const objectName = row.effective_mode === 'object' ? row.effective_object_name : null;
  const text = objectName ? `${label}: ${objectName}` : label;
  const inactiveObject = row.effective_mode === 'object' && row.effective_object_is_active === false;

  return (
    <span className="sc-cell-with-btn">
      {canEdit && (
        <button
          className="sc-inline-btn"
          title="Режим табелирования для 1С"
          onClick={e => { e.stopPropagation(); onEdit(); }}
        >
          <CalendarCog size={12} />
        </button>
      )}
      <span className="sc-obj-names" title={row.effective_object_address ?? text}>
        {text}
        {row.source === 'department_explicit' && (
          <span className="sc-obj-badge" title="Режим унаследован от отдела">насл.</span>
        )}
        {row.source.startsWith('legacy') && (
          <span className="sc-obj-badge" title="Режим не задан явно — выведен из назначений объектов">legacy</span>
        )}
        {inactiveObject && (
          <span className="sc-obj-badge sc-obj-badge--warn" title="Закреплённый объект неактивен — выберите другой">
            объект неактивен
          </span>
        )}
      </span>
    </span>
  );
};
