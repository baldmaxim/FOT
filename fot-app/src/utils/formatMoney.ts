/**
 * Форматирование денег для модуля KPI.
 *
 * Суммы приходят с бэкенда СТРОКАМИ: PostgreSQL numeric в JS-число превращать нельзя
 * без потери точности на больших договорах. Здесь строка нужна только для показа,
 * поэтому Number() допустим — арифметика вся осталась в SQL.
 */

const rubFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Полная сумма: «600 000 000,00 ₽». null → «—». */
export const formatMoney = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${rubFormatter.format(numeric)} ₽`;
};

/** Без копеек — для узких колонок таблицы, где важен порядок величины. */
export const formatMoneyShort = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${compactFormatter.format(numeric)} ₽`;
};

/** Процент выполнения. null означает «план не определён» и рисуется прочерком. */
export const formatPercent = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${numeric.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;
};

/** «2026-09-01» → «сентябрь 2026». */
export const formatMonthLabel = (periodMonth: string): string => {
  const [year, month] = periodMonth.split('-').map(Number);
  const name = new Date(Date.UTC(year, month - 1, 1))
    .toLocaleDateString('ru-RU', { month: 'long', timeZone: 'UTC' });
  return `${name} ${year}`;
};

/** «2026-09-01» → «01.09.2026». Пустое значение — прочерк. */
export const formatDate = (value: string | null | undefined): string => {
  if (!value) return '—';
  const [year, month, day] = value.split('-');
  return day ? `${day}.${month}.${year}` : value;
};
