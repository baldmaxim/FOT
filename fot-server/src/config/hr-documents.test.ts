import { describe, expect, it } from 'vitest';
import {
  HR_DOCUMENT_TYPES,
  fromHrCategory,
  getHrDocumentType,
  isHrCategory,
  requiresPatent,
  resolveDocumentProfile,
  resolveDocumentSlots,
  toHrCategory,
} from './hr-documents.js';

const RU = { requires_patent: false, is_eaeu: false, iso_code: 'RUS', name: 'Россия' };
const KZ = { requires_patent: false, is_eaeu: true, iso_code: 'KAZ', name: 'Казахстан' };
const UZ = { requires_patent: true, is_eaeu: false, iso_code: 'UZB', name: 'Узбекистан' };

describe('hr-documents: патент и профили', () => {
  it('нужен ли патент', () => {
    expect(requiresPatent(RU, false)).toBe(false);
    expect(requiresPatent(KZ, false)).toBe(false);
    expect(requiresPatent(UZ, false)).toBe(true);
    expect(requiresPatent(UZ, true)).toBe(false); // ВНЖ снимает
    expect(requiresPatent(null, false)).toBe(false);
  });

  it('профиль документов', () => {
    expect(resolveDocumentProfile(RU, false)).toBe('ru');
    expect(resolveDocumentProfile(KZ, false)).toBe('eaeu');
    expect(resolveDocumentProfile(UZ, false)).toBe('migrant');
    expect(resolveDocumentProfile(null, false)).toBe('ru');
  });

  it('ВНЖ убирает патент/КИГ из слотов мигранта', () => {
    const withPatent = resolveDocumentSlots('migrant', false);
    const withVnzh = resolveDocumentSlots('migrant', true);
    expect(withPatent.all).toContain('patent_front');
    expect(withPatent.required).toContain('kig');
    expect(withVnzh.all).not.toContain('patent_front');
    expect(withVnzh.all).not.toContain('kig');
    expect(withVnzh.required).not.toContain('patent_back');
    expect(withVnzh.all).toContain('passport_translation');
  });

  it('категории hr_* и каталог типов', () => {
    expect(toHrCategory('passport')).toBe('hr_passport');
    expect(fromHrCategory('hr_kig')).toBe('kig');
    expect(isHrCategory('payslip')).toBe(false);
    expect(getHrDocumentType('hr_snils_card')?.ocrType).toBe('snils');
    expect(getHrDocumentType('diploma')?.ocrType).toBeNull();
    expect(new Set(HR_DOCUMENT_TYPES.map(t => t.code)).size).toBe(25);
  });
});
