/**
 * Месяцы для «Статистики за месяц» в окне выгрузки «Сотрудники на объектах».
 * Граница та же, что проверяет сервер: текущий месяц и 11 предыдущих (по МСК).
 */

export const MONTHS_AVAILABLE = 12;

const MONTH_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

export interface IMonthOption {
  /** YYYY-MM */
  value: string;
  /** «Сентябрь 2026» */
  label: string;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Сдвиг месяца YYYY-MM на delta (отрицательный — назад), через границу года. */
export const shiftMonth = (month: string, delta: number): string => {
  const [year, monthNumber] = month.split('-').map(Number);
  const index = year * 12 + (monthNumber - 1) + delta;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
};

export const formatMonthLabel = (month: string): string => {
  const [year, monthNumber] = month.split('-').map(Number);
  const name = MONTH_NAMES[monthNumber - 1];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
};

/** Текущий месяц и 11 предыдущих, новые сверху. today — YYYY-MM-DD по МСК. */
export const buildMonthOptions = (today: string): IMonthOption[] => {
  const current = today.slice(0, 7);
  return Array.from({ length: MONTHS_AVAILABLE }, (_, index) => {
    const value = shiftMonth(current, -index);
    return { value, label: formatMonthLabel(value) };
  });
};

/** Диапазон месяца: с 1-го по последнее число, текущий — по «сегодня» включительно. */
export const monthRange = (month: string, today: string): { from: string; to: string } => {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const to = month === today.slice(0, 7) ? today : `${month}-${pad2(lastDay)}`;
  return { from: `${month}-01`, to };
};

/** «сентябрь_2026» — для запасного имени файла. */
export const monthFileSuffix = (month: string): string => formatMonthLabel(month).toLowerCase().replace(' ', '_');
