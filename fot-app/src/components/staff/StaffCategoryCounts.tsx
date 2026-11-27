import { Fragment, memo, type FC } from 'react';
import type { IStaffCategoryCounts, StaffCategory } from '../../services/employeeService';
import { STAFF_CATEGORY_OPTIONS } from '../../pages/staffControlPage.helpers';

interface IStaffCategoryCountsProps {
  counts: IStaffCategoryCounts;
  /** Выбранная группа; null — все строки вкладки. */
  category: StaffCategory | null;
  /** Группа или null («все»). Повторный клик по выбранной группе — тоже null. */
  onSelect: (category: StaffCategory | null) => void;
  /** header — маленькие кнопки в плашке шапки; row — чипы строкой под фильтрами (узкий экран). */
  variant: 'header' | 'row';
}

/**
 * «Все 1151 · ИТР 557 · Рабочие 582 · Остальные 12»: «Все» — вся вкладка, клик по группе оставляет в таблице
 * только её. Выбранная кнопка подсвечена; без группы подсвечено «Все». Подсказок при наведении нет (27.11.2026):
 * выбор виден подсветкой.
 */
export const StaffCategoryCounts: FC<IStaffCategoryCountsProps> = memo(({ counts, category, onSelect, variant }) => {
  const buttonClass = (active: boolean): string => {
    const base = variant === 'header' ? 'sc-cat-btn' : 'sc-movement-chip sc-cat-chip';
    return active ? `${base} is-active` : base;
  };
  return (
    <span
      className={`sc-category-counts sc-category-counts--${variant}`}
      role="group"
      aria-label="Состав таблицы: ИТР, рабочие, остальные"
    >
      <button
        type="button"
        className={buttonClass(category === null)}
        aria-pressed={category === null}
        onClick={() => onSelect(null)}
      >
        Все {counts.total}
      </button>
      {STAFF_CATEGORY_OPTIONS.map(option => {
        const active = category === option.key;
        return (
          <Fragment key={option.key}>
            {variant === 'header' && <span className="sc-cat-sep" aria-hidden="true">·</span>}
            <button
              type="button"
              className={buttonClass(active)}
              aria-pressed={active}
              onClick={() => onSelect(active ? null : option.key)}
            >
              {option.label} {counts[option.key]}
            </button>
          </Fragment>
        );
      })}
    </span>
  );
});
