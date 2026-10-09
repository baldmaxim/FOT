/**
 * Выбор нескольких месяцев (YYYY-MM): подпись выбора и переключение месяца — общие для
 * «KPI объектов» и «Зарплата → Подробно».
 */
import { formatMonthLabel } from './formatMoney';
import { shiftMonth } from './moscowDate';

/** «август 2026»; подряд — «июль 2026 — сентябрь 2026»; вразброс — «июль 2026, сентябрь 2026». */
export const formatMonthsLabel = (months: ReadonlyArray<string>): string => {
  const sorted = [...months].sort();
  if (sorted.length === 0) return '';
  const label = (month: string) => formatMonthLabel(`${month}-01`);
  if (sorted.length === 1) return label(sorted[0]);
  const contiguous = sorted.every((month, index) => index === 0 || shiftMonth(sorted[index - 1], 1) === month);
  return contiguous
    ? `${label(sorted[0])} — ${label(sorted[sorted.length - 1])}`
    : sorted.map(label).join(', ');
};

/**
 * Отметить месяц или снять отметку; выбор — по порядку. allowEmpty=false — последний
 * выбранный месяц не снимается (возвращается прежний массив): пустой выбор там не имеет смысла.
 */
export const toggleMonthSelection = (
  value: ReadonlyArray<string>,
  month: string,
  allowEmpty: boolean,
): string[] => {
  if (!value.includes(month)) return [...value, month].sort();
  if (!allowEmpty && value.length === 1) return [...value];
  return value.filter(item => item !== month);
};
