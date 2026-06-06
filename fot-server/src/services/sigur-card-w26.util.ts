/**
 * Декодирование карты в формат Sigur W26 (чистая утилита, без внешних зависимостей).
 *
 * Принимает либо сырой UID ридера (`182678A500000000`), либо уже готовый W26
 * (`facility,number`, напр. `168,15956`). Возвращает:
 *  - value     — 3-байтовый uppercase hex (как Sigur хранит `value`);
 *  - facility  — первый из 3 байт (0–255);
 *  - number    — последние 2 байта (0–65535);
 *  - w26       — человекочитаемое `facility,number`.
 *
 * Формула для сырого UID выверена по ground-truth: значимые младшие 3 байта UID.
 * Strip хвостовых нулей → 8 hex → отбросить ведущий байт → 6 hex. Пример:
 * `18A83E54..` → value `A83E54` → W26 `168,15956`.
 */
export interface ICardW26 {
  value: string;
  facility: number;
  number: number;
  w26: string;
}

const valueToW26 = (valueHex: string): ICardW26 => {
  const facility = parseInt(valueHex.slice(0, 2), 16);
  const number = parseInt(valueHex.slice(2), 16);
  return { value: valueHex, facility, number, w26: `${facility},${number}` };
};

export function deriveCardW26(input: string): ICardW26 {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Пустой UID/W26 карты');
  }
  const trimmed = input.trim();

  // Готовый W26: "facility,number".
  if (trimmed.includes(',')) {
    const [facRaw, numRaw] = trimmed.split(',', 2).map(s => s.trim());
    const facility = Number(facRaw);
    const number = Number(numRaw);
    if (!Number.isInteger(facility) || !Number.isInteger(number)
      || facility < 0 || facility > 0xFF || number < 0 || number > 0xFFFF) {
      throw new Error(`Некорректный W26: ${input}`);
    }
    const value = (facility.toString(16).padStart(2, '0') + number.toString(16).padStart(4, '0')).toUpperCase();
    return { value, facility, number, w26: `${facility},${number}` };
  }

  // Сырой UID (hex).
  const hex = trimmed.toUpperCase().replace(/[^0-9A-F]/g, '');
  if (!hex) {
    throw new Error(`Некорректный UID: ${input}`);
  }
  const significant = hex.replace(/0+$/g, '');
  const hex8 = significant.padStart(8, '0').slice(-8);
  const value = hex8.slice(2); // отбросить ведущий байт (0x18)
  if (value.length !== 6) {
    throw new Error(`Не удалось вывести value из UID: ${input}`);
  }
  return valueToW26(value);
}
