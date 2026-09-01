import { describe, expect, it } from 'vitest';
import {
  getMissingRequiredOcrFields,
  hasMeaningfulNormalizedData,
  normalizeDate,
  normalizeKigNumber,
  normalizeResponseByType,
  parseStructuredJson,
  passesQualityGate,
  resolveOcrType,
  valueFrom,
} from './normalize.js';

describe('hr-ocr normalize: тип документа', () => {
  it('passport → по типу паспорта', () => {
    expect(resolveOcrType('passport', null)).toBe('passport_rf');
    expect(resolveOcrType('passport', 'foreign')).toBe('foreign_passport');
    expect(resolveOcrType('patent_back', null)).toBe('patent');
    expect(resolveOcrType('inn_document', null)).toBe('inn');
    expect(resolveOcrType('snils_card', null)).toBe('snils');
    expect(resolveOcrType('diploma', null)).toBeNull();
  });
});

describe('hr-ocr normalize: парсер', () => {
  it('json в markdown-заборе', () => {
    expect(parseStructuredJson('```json\n{"inn": "123"}\n```')).toEqual({ inn: '123' });
  });
  it('битый json → key:value', () => {
    expect(parseStructuredJson('{"snils": "123",}')).toEqual({ snils: '123' });
  });
  it('построчный формат', () => {
    expect(parseStructuredJson('surname: Иванов\ngivenNames: "Иван"')).toEqual({ surname: 'Иванов', givenNames: 'Иван' });
  });
});

describe('hr-ocr normalize: примитивы', () => {
  it('normalizeDate: dd.mm.yyyy и yyyy-mm-dd', () => {
    expect(normalizeDate('15.06.2022')).toBe('2022-06-15');
    expect(normalizeDate('2022-06-15T00:00:00')).toBe('2022-06-15');
    expect(normalizeDate('01/02/99')).toBe('1999-02-01');
  });
  it('КИГ: 2 буквы + 7 цифр', () => {
    expect(normalizeKigNumber('AB 0339982')).toBe('AB0339982');
    expect(normalizeKigNumber('7712345678901')).toBeNull();
  });
  it('valueFrom по алиасам и нормализованным ключам', () => {
    expect(valueFrom({ 'Passport Number': ' 4510 ' }, ['passportNumber'])).toBe('4510');
    expect(valueFrom({}, ['x'])).toBeNull();
  });
});

describe('hr-ocr normalize: по типу', () => {
  it('паспорт РФ: серия+номер из объединённого поля', () => {
    const n = normalizeResponseByType('passport_rf', { surname: 'Иванов', passportNumber: '4510 123456', sex: 'м', departmentCode: '770-001' });
    expect(n.passportSeries).toBe('4510');
    expect(n.passportNumber).toBe('123456');
    expect(n.sex).toBe('M');
    expect(n.lastName).toBe('Иванов');
  });
  it('иностранный паспорт: ФИО всегда null', () => {
    const n = normalizeResponseByType('foreign_passport', { surname: 'IVANOV', passportNumber: 'AA 1234567', nationality: 'ТОЧИКИСТОН/TAJIKISTAN' });
    expect(n.lastName).toBeNull();
    expect(n.passportNumber).toBe('AA1234567');
    // 3-буквенный ISO извлекается только из отдельного токена; длинные названия остаются как есть (их разбирает apply/справочник).
    expect(n.citizenship).toBe('ТОЧИКИСТОН/TAJIKISTAN');
    expect(normalizeResponseByType('foreign_passport', { nationality: 'UZB' }).citizenship).toBe('UZB');
  });
  it('патент: бланк не попадает в номер', () => {
    const n = normalizeResponseByType('patent', { patentNumber: 'ПР1234567', blankNumber: '' });
    expect(n.blankNumber).toBe('ПР1234567');
    expect(n.patentNumber).toBeNull();
  });
  it('ИНН/СНИЛС: ровно 12/11 цифр', () => {
    expect(normalizeResponseByType('inn', { inn: '7701 234567 89' }).inn).toBe('770123456789');
    expect(normalizeResponseByType('snils', { snils: '123-456-789 01' }).snils).toBe('12345678901');
    expect(normalizeResponseByType('snils', { snils: '12' }).snils).toBeNull();
  });
  it('регистрация: адрес собирается из частей', () => {
    const n = normalizeResponseByType('registration_amina', { locality: 'Москва', street: 'Тверская', house: '1', apartment: '2', phone: '9101234567' });
    expect(n.registrationAddress).toBe('Москва, ул. Тверская, д. 1, кв. 2');
    expect(n.phone).toBe('+79101234567');
  });
});

describe('hr-ocr normalize: quality gate', () => {
  it('перевод паспорта без якоря — не проходит', () => {
    expect(passesQualityGate('passport_translation', { lastName: 'Иванов', firstName: 'Иван' })).toBe(false);
    expect(passesQualityGate('passport_translation', { lastName: 'Иванов', firstName: 'Иван', birthDate: '1990-01-01' })).toBe(true);
    expect(getMissingRequiredOcrFields('snils', {})).toEqual(['snils']);
    expect(hasMeaningfulNormalizedData({ inn: null, snils: ' ' })).toBe(false);
  });
});
