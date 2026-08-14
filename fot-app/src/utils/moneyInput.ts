/**
 * Ввод денежных сумм с разделителями тысяч.
 *
 * Маска применяется на каждый keystroke, поэтому она обязана быть идемпотентной:
 * formatMoneyInput(formatMoneyInput(x)) === formatMoneyInput(x).
 *
 * parseMoneyInput возвращает СТРОКУ, а не number: суммы уезжают в PostgreSQL numeric,
 * и промежуточный float на больших договорах теряет копейки.
 */

const groupFormatter = new Intl.NumberFormat('ru-RU');

interface IMoneyInputOptions {
  /**
   * Разрешить минус. Нужен только допсоглашениям: amount_delta бывает отрицательной,
   * а у КС-2, КС-6 и стоимости договора знак ставит сервер или он запрещён вовсе.
   */
  allowNegative?: boolean;
}

export const formatMoneyInput = (
  value: string,
  { allowNegative = false }: IMoneyInputOptions = {},
): string => {
  const raw = value.replace(/\s+/g, '');
  const negative = allowNegative && raw.trimStart().startsWith('-');

  const cleaned = raw.replace(/[^\d.,]/g, '').replace(/\./g, ',');
  if (!cleaned) return negative ? '-' : '';

  const separatorIndex = cleaned.indexOf(',');
  const hasFraction = separatorIndex >= 0;
  const integerRaw = (hasFraction ? cleaned.slice(0, separatorIndex) : cleaned).replace(/\D/g, '');
  const fraction = (hasFraction ? cleaned.slice(separatorIndex + 1) : '')
    .replace(/\D/g, '')
    .slice(0, 2);

  const normalizedInteger = integerRaw.replace(/^0+(?=\d)/, '') || (integerRaw ? '0' : '');
  const formattedInteger = normalizedInteger
    ? groupFormatter.format(Number(normalizedInteger))
    : '';

  const body = hasFraction ? `${formattedInteger || '0'},${fraction}` : formattedInteger;
  return negative ? `-${body}` : body;
};

/** Строка для отправки на сервер: без пробелов, с точкой. Пустой ввод → null. */
export const parseMoneyInput = (value: string): string | null => {
  const normalized = value.replace(/\s+/g, '').replace(',', '.').trim();
  if (!normalized || normalized === '-' || normalized === '.') return null;
  return normalized;
};

/** Значение из БД (numeric-строка) в маску поля. */
export const toMoneyInput = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '';
  return formatMoneyInput(String(value).replace('.', ','), { allowNegative: true });
};
