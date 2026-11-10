import type { IPassRow } from '../services/contractorService';
import { citizenshipRequiresPatent } from '../services/citizenship';

/**
 * Все документы держателя заполнены (для зелёной галочки на кнопке «Документы»).
 * Паспорт, даты и гражданство — всегда; для патентных гражданств — патент,
 * НО ВНЖ его отменяет: с отметкой ВНЖ достаточно номера ВНЖ вместо патента.
 * СНИЛС, ИНН и КиГ необязательные — на полноту не влияют.
 * Зеркало isDocsComplete на бэке (contractor-docs.service) — держать в синхроне.
 */
export const hasAllDocs = (p: IPassRow): boolean => {
  const base = !!(p.passport_series_number?.trim() && p.passport_issue_date
    && p.birth_date && p.citizenship?.trim());
  if (!base) return false;
  if (!citizenshipRequiresPatent(p.citizenship)) return true;
  // ВНЖ отменяет патент: для патентной страны с ВНЖ нужен номер ВНЖ.
  if (p.has_residence_permit) return !!p.residence_permit_number?.trim();
  return !!(p.patent_number?.trim() && p.patent_issue_date && p.patent_blank_number?.trim());
};

/** В пропуске заполнен хоть один документ держателя (включая СНИЛС/ИНН/КиГ). */
export const hasAnyDocs = (p: IPassRow): boolean =>
  p.has_residence_permit
  || [
    p.passport_series_number, p.passport_issue_date, p.birth_date, p.citizenship,
    p.patent_number, p.patent_issue_date, p.patent_blank_number, p.residence_permit_number,
    p.snils, p.inn, p.kig, p.kig_end_date,
  ].some(v => (v ?? '').trim().length > 0);
