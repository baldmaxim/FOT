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

  // Сырой UID (hex). Ридер кадрирует как ведущий байт (0x18) + 3 байта value +
  // хвостовые нулевые байты. value = байты 1..3 первых четырёх = hex[2..8].
  // ВАЖНО: нельзя «стрипать хвостовые нули» по полубайтам — если значимый байт
  // оканчивается нулём (напр. ...5490), это съест значащий ноль и сдвинет value.
  const hex = trimmed.toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length < 8) {
    throw new Error(`Слишком короткий UID (нужно ≥8 hex): ${input}`);
  }
  const value = hex.slice(2, 8); // отбросить ведущий байт, взять 3 байта value
  return valueToW26(value);
}

/** Канонический W26 «FFF,NNNNN» — Sigur паддит facility, сравнивать нужно в одном виде. */
export function formatW26(decoded: ICardW26): string {
  return `${String(decoded.facility).padStart(3, '0')},${String(decoded.number).padStart(5, '0')}`;
}

export interface ISigurCardIdentity {
  /** 3-байтовый value карты; null — вывести не удалось. */
  value: string | null;
  /** Канонический W26 «FFF,NNNNN»; null — вывести не удалось. */
  w26: string | null;
  facility: number | null;
}

/**
 * Идентичность карты из сырой записи каталога Sigur.
 *
 * ВАЖНО: `value` каталога — 3 байта (6 hex, напр. `26CFFD`), а `deriveCardW26` принимает
 * только `facility,number` либо сырой UID ридера (≥8 hex). Поэтому на «голом» value он
 * законно бросает, и единственный способ вывести W26 — `formattedValue`. Один helper на
 * инвентаризацию и на боевую сверку: если их развести, confirmation и запись разойдутся.
 *
 * `w26 === null` — идентичность НЕ выведена (value при этом может быть непустым).
 */
export function deriveSigurCardIdentity(rawValue: string, rawFormatted: string): ISigurCardIdentity {
  const value = (rawValue ?? '').trim();
  const formatted = (rawFormatted ?? '').trim();

  // Сам value декодируется — берём канонический 3-байтовый value из декодера.
  if (value) {
    try {
      const decoded = deriveCardW26(value);
      return { value: decoded.value, w26: formatW26(decoded), facility: decoded.facility };
    } catch {
      /* 6-hex value каталога сюда и попадает — идём в formattedValue */
    }
  }

  // Фолбэк: W26 берём из formattedValue, а value оставляем как в каталоге.
  if (formatted) {
    try {
      const decoded = deriveCardW26(formatted);
      return { value: value || decoded.value, w26: formatW26(decoded), facility: decoded.facility };
    } catch {
      /* идентичность не выводится */
    }
  }

  return { value: value || null, w26: null, facility: null };
}
