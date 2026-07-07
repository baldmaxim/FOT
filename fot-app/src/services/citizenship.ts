/**
 * Справочник гражданств держателей подрядных пропусков.
 * От гражданства зависит, нужен ли патент: визово-безвизовые не-ЕАЭС обязаны
 * иметь патент, граждане ЕАЭС и «Другое» — нет.
 *
 * Набор патентных стран продублирован на бэке (CITIZENSHIP_PATENT_SET в
 * contractor-docs.service) и в SQL documents_complete — держать в синхроне.
 */

export interface ICitizenshipOption {
  /** Хранимое значение (метка как есть). */
  value: string;
  /** Нужен ли патент гражданину этой страны. */
  requiresPatent: boolean;
}

export const CITIZENSHIP_OPTIONS: ICitizenshipOption[] = [
  // ЕАЭС — патент не нужен.
  { value: 'Россия', requiresPatent: false },
  { value: 'Беларусь', requiresPatent: false },
  { value: 'Казахстан', requiresPatent: false },
  { value: 'Армения', requiresPatent: false },
  { value: 'Кыргызстан', requiresPatent: false },
  // Визово-безвизовые не-ЕАЭС — нужен патент.
  { value: 'Узбекистан', requiresPatent: true },
  { value: 'Таджикистан', requiresPatent: true },
  { value: 'Украина', requiresPatent: true },
  { value: 'Азербайджан', requiresPatent: true },
  { value: 'Молдова', requiresPatent: true },
  { value: 'Туркменистан', requiresPatent: true },
  // Прочие (визовые и т.п.) — патент не запрашиваем.
  { value: 'Другое', requiresPatent: false },
];

/** Множество патентных гражданств (UPPER) для регистронезависимого сравнения. */
const PATENT_SET = new Set(
  CITIZENSHIP_OPTIONS.filter(o => o.requiresPatent).map(o => o.value.toUpperCase()),
);

/** Нужен ли патент гражданину с данным гражданством (регистронезависимо). */
export const citizenshipRequiresPatent = (v: string | null | undefined): boolean =>
  !!v && PATENT_SET.has(v.trim().toUpperCase());
