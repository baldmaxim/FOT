/**
 * Компании «Управления кадрами». Бригады входят в свою компанию (СУ-10 / СМ), отдельного
 * пункта нет; «Прочие» видны только во «Все компании».
 */
export type StaffSection = 'su10' | 'sm' | 'contractors' | 'all';

export const STAFF_SECTION_OPTIONS: ReadonlyArray<{ value: StaffSection; label: string }> = [
  { value: 'su10', label: 'СУ-10' },
  { value: 'sm', label: 'СМ' },
  { value: 'contractors', label: 'Подрядные организации' },
  { value: 'all', label: 'Все компании' },
];

/** Старый ?section=brigades из закладок сюда не проходит — берётся раздел по умолчанию. */
export const isStaffSection = (value: unknown): value is StaffSection =>
  typeof value === 'string' && STAFF_SECTION_OPTIONS.some(option => option.value === value);
