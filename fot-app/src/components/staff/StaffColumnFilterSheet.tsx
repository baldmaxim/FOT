import { useEffect, type FC } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Filter } from 'lucide-react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { StaffSortKey } from '../../services/employeeService';
import { countActiveColumnFilters, isColumnFilterActive, type IStaffColumnFilters } from '../../utils/staffColumnFilters';
import { STAFF_SORT_OPTIONS } from './staffSort';

interface IStaffColumnFilterSheetProps {
  filters: IStaffColumnFilters;
  onPick: (column: StaffSortKey) => void;
  onReset: () => void;
  onClose: () => void;
}

/** Мобила: список столбцов с отметкой активных фильтров; выбор открывает редактор фильтра. */
export const StaffColumnFilterSheet: FC<IStaffColumnFilterSheetProps> = ({ filters, onPick, onReset, onClose }) => {
  const dismiss = useOverlayDismiss(onClose);
  const activeCount = countActiveColumnFilters(filters);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="sc-colfilter-backdrop" {...dismiss} />
      <div className="sc-colfilter sc-colfilter--sheet" role="dialog" aria-modal="true" aria-label="Фильтры столбцов">
        <div className="sc-colfilter-title">Фильтры столбцов</div>
        <div className="sc-colfilter-columns">
          {STAFF_SORT_OPTIONS.map(option => {
            const active = isColumnFilterActive(filters, option.key);
            return (
              <button key={option.key} type="button" className="sc-colfilter-column" onClick={() => onPick(option.key)}>
                <span>{option.label}</span>
                {active && <Filter size={12} aria-label="фильтр включён" className="sc-colfilter-column-active" />}
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="sc-colfilter-footer">
          <button type="button" className="sc-btn cancel" onClick={onReset} disabled={activeCount === 0}>Сбросить все</button>
          <button type="button" className="sc-btn apply" onClick={onClose}>Готово</button>
        </div>
      </div>
    </>,
    document.body,
  );
};
