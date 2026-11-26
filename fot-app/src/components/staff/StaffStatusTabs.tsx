import { type FC } from 'react';
import type { StaffStatusFilter } from '../../pages/staffControlPage.helpers';

const TABS: ReadonlyArray<{ value: StaffStatusFilter; label: string }> = [
  { value: 'active', label: 'Активные' },
  { value: 'fired', label: 'Уволенные' },
  { value: 'all', label: 'Все' },
];

interface IStaffStatusTabsProps {
  value: StaffStatusFilter;
  onChange: (next: StaffStatusFilter) => void;
}

/** «Активные | Уволенные | Все» — на месте прежнего «Действующие | Уволенные», в тех же стилях. */
export const StaffStatusTabs: FC<IStaffStatusTabsProps> = ({ value, onChange }) => (
  <div className="sc-segmented" role="tablist" aria-label="Статус сотрудников">
    {TABS.map(tab => (
      <button
        key={tab.value}
        type="button"
        role="tab"
        aria-selected={value === tab.value}
        className={`sc-seg-btn${value === tab.value ? ' is-active' : ''}`}
        onClick={() => onChange(tab.value)}
      >
        {tab.label}
      </button>
    ))}
  </div>
);
