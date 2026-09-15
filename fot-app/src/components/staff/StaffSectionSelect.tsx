import { type FC } from 'react';
import { STAFF_SECTION_OPTIONS, isStaffSection, type StaffSection } from './staffSections';

interface IStaffSectionSelectProps {
  value: StaffSection;
  onChange: (value: StaffSection) => void;
}

export const StaffSectionSelect: FC<IStaffSectionSelectProps> = ({ value, onChange }) => (
  <select
    className="sc-schedule-filter sc-section-filter"
    value={value}
    onChange={event => {
      if (isStaffSection(event.target.value)) onChange(event.target.value);
    }}
    title="Компания: СУ-10, СМ, бригады, подрядные организации или все компании"
    aria-label="Раздел"
  >
    {STAFF_SECTION_OPTIONS.map(option => (
      <option key={option.value} value={option.value}>{option.label}</option>
    ))}
  </select>
);
