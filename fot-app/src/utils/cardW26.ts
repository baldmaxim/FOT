/**
 * Клиентский порт декодера карты в формат Sigur W26 (facility,number).
 * Зеркалит бэкенд `deriveCardW26` (fot-server/src/services/sigur-card-w26.util.ts):
 * принимает либо сырой UID ридера (`1826CCC200000000`), либо уже готовый W26
 * (`38,52418`) и возвращает человекочитаемое `facility,number`.
 *
 * Нужно для отображения: в столбцах «Подрядчики» показываем W26 вместо сырого UID —
 * так видны коллизии (разные физические карты, свёрнутые в один 24-битный W26).
 */

/** Декодирует UID/W26 в строку `facility,number`; при неудаче возвращает исходную строку. */
export const formatCardW26 = (input: string | null | undefined): string => {
  if (typeof input !== 'string' || !input.trim()) return '—';
  const trimmed = input.trim();

  // Готовый W26: "facility,number" — нормализуем числа.
  if (trimmed.includes(',')) {
    const [facRaw, numRaw] = trimmed.split(',', 2).map(s => s.trim());
    const facility = Number(facRaw);
    const number = Number(numRaw);
    if (Number.isInteger(facility) && Number.isInteger(number)
      && facility >= 0 && facility <= 0xFF && number >= 0 && number <= 0xFFFF) {
      return `${facility},${number}`;
    }
    return trimmed; // некорректный W26 — показываем как есть
  }

  // Сырой UID (hex): отбросить ведущий байт длины, взять 3 байта value = hex[2..8].
  const hex = trimmed.toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length < 8) return trimmed; // слишком короткий — не декодируем
  const value = hex.slice(2, 8);
  const facility = parseInt(value.slice(0, 2), 16);
  const number = parseInt(value.slice(2), 16);
  if (!Number.isFinite(facility) || !Number.isFinite(number)) return trimmed;
  return `${facility},${number}`;
};
