/**
 * Проверяет валидность даты
 */
export function isValidDate(date: Date): boolean {
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * Форматирует дату в ISO формат (YYYY-MM-DD)
 */
export function formatDateToISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Парсит дату из различных форматов
 */
export function parseDate(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;

  // Если это уже Date объект
  if (value instanceof Date) {
    return formatDateToISO(value);
  }

  const str = String(value).trim();
  if (!str) return null;

  // Пробуем различные форматы

  // Excel serial date (число)
  if (!isNaN(Number(str))) {
    const num = Number(str);
    // Excel даты: дни с 1900-01-01 (с поправкой на баг 1900 года)
    if (num > 1 && num < 100000) {
      const excelEpoch = new Date(1899, 11, 30);
      const date = new Date(excelEpoch.getTime() + num * 24 * 60 * 60 * 1000);
      return formatDateToISO(date);
    }
  }

  // DD.MM.YYYY или DD/MM/YYYY
  const dmyMatch = str.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (isValidDate(date)) {
      return formatDateToISO(date);
    }
  }

  // YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (isValidDate(date)) {
      return formatDateToISO(date);
    }
  }

  // Пробуем стандартный Date.parse
  const parsed = new Date(str);
  if (isValidDate(parsed)) {
    return formatDateToISO(parsed);
  }

  return null;
}
