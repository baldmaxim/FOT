/** Разделы «Управления кадрами» — как листы Excel-выгрузки; «Прочие» видны только во «Все». */
export type StaffSection = 'su10' | 'sm' | 'brigades' | 'contractors' | 'all';

export const STAFF_SECTION_OPTIONS: ReadonlyArray<{ value: StaffSection; label: string }> = [
  { value: 'su10', label: 'СУ-10' },
  { value: 'sm', label: 'СМ' },
  { value: 'brigades', label: 'Бригады' },
  { value: 'contractors', label: 'Подрядчики' },
  { value: 'all', label: 'Все' },
];

export const isStaffSection = (value: unknown): value is StaffSection =>
  typeof value === 'string' && STAFF_SECTION_OPTIONS.some(option => option.value === value);
