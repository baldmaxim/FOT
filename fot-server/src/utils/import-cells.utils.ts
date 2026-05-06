/**
 * Утилиты для импорта Excel-ячеек: единая нормализация и парсинг чисел
 * с поддержкой RU/EN форматов разделителей (для оклада и т.п.).
 */

/**
 * Текст из ячейки Excel: trim, отсев пустых и заглушек "-"/"—".
 * Возвращает null, если значение пустое.
 */
export const cleanCell = (val: unknown): string | null => {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s || s === '-' || s === '—') return null;
  return s;
};

/**
 * Парсит число из ячейки с учётом локалей:
 *  - "110,000.00"  (EN тысячный + десятичная точка) → 110000.00
 *  - "110 000,00"  (RU тысячный пробел + запятая)  → 110000.00
 *  - "130,50"      (RU короткий формат)            → 130.50
 *  - "130,000"     (EN тысячный без дроби)         → 130000
 */
export const parseNumber = (val: unknown): number | null => {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  let s = String(val).trim();
  if (!s || s === '-' || s === '—') return null;
  // Все виды пробелов: обычный, non-breaking (U+00A0), narrow no-break (U+202F)
  s = s.replace(/[\s  ]/g, '');
  if (s.includes('.') && s.includes(',')) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastDot > lastComma) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
    }
  } else if (s.includes(',')) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      s = s.replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};
