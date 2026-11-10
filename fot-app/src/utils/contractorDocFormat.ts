/**
 * СНИЛС, ИНН и КиГ в документах держателя подрядного пропуска (окно «Документы»).
 * Правила зеркальны бэку (contractor-docs.service): СНИЛС — 11 цифр, ИНН физлица — 12,
 * КиГ — только у иностранца (гражданство выбрано и не Россия).
 */

export const SNILS_DIGITS = 11;
export const INN_DIGITS = 12;

export const digitsOnly = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '');

/** Постепенная маска СНИЛС: 123-456-789 00 (лишние цифры отрезаются). */
export const formatSnilsInput = (raw: string | null | undefined): string => {
  const d = digitsOnly(raw).slice(0, SNILS_DIGITS);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)} ${d.slice(9)}`;
};

/** ИНН при вводе: только цифры, не больше 12. */
export const formatInnInput = (raw: string | null | undefined): string => digitsOnly(raw).slice(0, INN_DIGITS);

/** Пусто или ровно 11 цифр. */
export const isValidSnils = (v: string | null | undefined): boolean => {
  const n = digitsOnly(v).length;
  return n === 0 || n === SNILS_DIGITS;
};

/** Пусто или ровно 12 цифр. */
export const isValidInn = (v: string | null | undefined): boolean => {
  const n = digitsOnly(v).length;
  return n === 0 || n === INN_DIGITS;
};

/** Гражданин России (регистро- и пробелонезависимо). */
export const citizenshipIsRussia = (c: string | null | undefined): boolean => {
  const v = (c ?? '').trim().toUpperCase();
  return v === 'РОССИЯ' || v === 'РФ' || v === 'РОССИЙСКАЯ ФЕДЕРАЦИЯ';
};

/** Нужна ли КиГ: гражданство выбрано и это не Россия. */
export const citizenshipNeedsKig = (c: string | null | undefined): boolean =>
  (c ?? '').trim().length > 0 && !citizenshipIsRussia(c);
