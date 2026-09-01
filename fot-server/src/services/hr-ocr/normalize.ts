/**
 * Нормализация ответа модели по типу документа. Порт PassDesk
 * (server/src/services/ocr/ocrService.js: normalize*, valueFrom, parseStructuredJson,
 * qualityGate.js, resultValidation.js). Логику не переписывали — только типы.
 */
import type { HrOcrType } from '../../config/hr-documents.js';
import { HR_OCR_TYPES } from '../../config/hr-documents.js';

export type ParsedJson = Record<string, unknown>;

/** Единый набор нормализованных ключей (все опциональны). */
export interface IOcrNormalized {
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  birthDate?: string | null;
  sex?: 'M' | 'F' | null;
  citizenship?: string | null;
  passportSeries?: string | null;
  passportNumber?: string | null;
  passportIssuedAt?: string | null;
  passportIssuedBy?: string | null;
  passportDepartmentCode?: string | null;
  passportExpiryDate?: string | null;
  birthPlace?: string | null;
  registrationAddress?: string | null;
  phone?: string | null;
  inn?: string | null;
  snils?: string | null;
  kig?: string | null;
  kigEndDate?: string | null;
  patentNumber?: string | null;
  patentIssueDate?: string | null;
  patentExpiryDate?: string | null;
  blankNumber?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  bankInn?: string | null;
  bankBik?: string | null;
  bankCorrAccount?: string | null;
  insurancePolicyNumber?: string | null;
  insurancePolicyDate?: string | null;
  visaNumber?: string | null;
  visaIssueDate?: string | null;
  visaExpiryDate?: string | null;
}

// ─── Тип документа ──────────────────────────────────────────────────────────

const OCR_TYPE_SET = new Set<string>(HR_OCR_TYPES);

/**
 * Код скана (без hr_) → OCR-тип. passport → passport_rf по умолчанию; для
 * иностранного паспорта вызывающий передаёт passportType='foreign'.
 */
export const resolveOcrType = (
  documentCode: string | null | undefined,
  passportType: 'russian' | 'foreign' | null | undefined,
): HrOcrType | null => {
  const normalized = String(documentCode || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'passport' || normalized === 'passport_rf') {
    return passportType === 'foreign' ? 'foreign_passport' : 'passport_rf';
  }
  if (normalized === 'foreignpassport' || normalized === 'foreign-passport' || normalized === 'passport_foreign' || normalized === 'foreign_passport') {
    return 'foreign_passport';
  }
  if (normalized === 'patent_front' || normalized === 'patent_back' || normalized === 'patent_payment_receipt' || normalized === 'patent') return 'patent';
  if (normalized === 'inn_document' || normalized === 'inn') return 'inn';
  if (normalized === 'snils_card' || normalized === 'snils') return 'snils';
  if (OCR_TYPE_SET.has(normalized)) return normalized as HrOcrType;
  return null;
};

// ─── Примитивы ──────────────────────────────────────────────────────────────

const MALE_VALUES = new Set(['m', 'male', 'м', 'муж', 'мужской']);
const FEMALE_VALUES = new Set(['f', 'female', 'ж', 'жен', 'женский']);

export const normalizeDate = (value: unknown): string | null => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const pad2 = (part: string | number): string => String(part).padStart(2, '0');
  const toIsoDate = (year: string, month: string, day: string): string | null => {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
  };

  const ymd = raw.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (ymd) {
    const iso = toIsoDate(ymd[1], ymd[2], ymd[3]);
    if (iso) return iso;
  }
  const dmy = raw.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (dmy) {
    let year = dmy[3];
    if (year.length === 2) {
      const twoDigit = Number(year);
      year = String(twoDigit >= 70 ? 1900 + twoDigit : 2000 + twoDigit);
    }
    const iso = toIsoDate(year, dmy[2], dmy[1]);
    if (iso) return iso;
  }
  return raw;
};

const normalizeSex = (value: unknown): 'M' | 'F' | null => {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  if (MALE_VALUES.has(normalized)) return 'M';
  if (FEMALE_VALUES.has(normalized)) return 'F';
  return null;
};

const normalizeCitizenship = (value: unknown): string | null => {
  if (!value) return null;
  const raw = String(value).trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes('рос') || normalized === 'ru' || normalized === 'rus') return 'RUS';
  const parts = raw.toUpperCase().split(/[/,|\s]+/).filter(Boolean);
  const iso = parts.find(p => /^[A-Z]{3}$/.test(p));
  if (iso) return iso;
  return raw.toUpperCase();
};

export const normalizeDigits = (value: unknown, maxLength = 64): string | null => {
  if (!value) return null;
  const normalized = String(value).replace(/[^\d]/g, '').slice(0, maxLength);
  return normalized || null;
};

const normalizePhone = (value: unknown): string | null => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return raw;
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) return `+7${digits.slice(1)}`;
  return raw;
};

const normalizeAddressPart = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();

const buildRegistrationAddress = (parsed: ParsedJson): string | null => {
  const directAddress = normalizeAddressPart(valueFrom(parsed, [
    'registrationAddress', 'registration_address', 'address', 'addressLine', 'address_line',
    'registrationPlace', 'registration_place', 'адрес регистрации', 'адрес',
  ]));
  const locality = normalizeAddressPart(valueFrom(parsed, [
    'locality', 'city', 'settlement', 'location', 'place', 'населенный пункт', 'населённый пункт', 'город',
  ]));
  const streetRaw = normalizeAddressPart(valueFrom(parsed, ['street', 'streetName', 'street_name', 'улица']));
  const houseRaw = normalizeAddressPart(valueFrom(parsed, ['house', 'houseNumber', 'house_number', 'дом']));
  const apartmentRaw = normalizeAddressPart(valueFrom(parsed, ['apartment', 'apartmentNumber', 'apartment_number', 'flat', 'квартира', 'кв']));

  const parts: string[] = [];
  const baseAddress = directAddress || locality;
  if (baseAddress) parts.push(baseAddress);
  const baseLower = String(baseAddress || '').toLowerCase();

  if (streetRaw) {
    const streetLower = streetRaw.toLowerCase();
    if (!baseLower.includes(streetLower)) parts.push(streetLower.startsWith('ул') ? streetRaw : `ул. ${streetRaw}`);
  }
  if (houseRaw) {
    const houseDigits = houseRaw.replace(/[^\dA-Za-zА-Яа-яЁё/-]/g, '');
    if (houseDigits && !baseLower.includes(houseDigits.toLowerCase())) {
      parts.push(houseRaw.toLowerCase().startsWith('д') ? houseRaw : `д. ${houseRaw}`);
    }
  }
  if (apartmentRaw) {
    const apartmentDigits = apartmentRaw.replace(/[^\dA-Za-zА-Яа-яЁё/-]/g, '');
    if (apartmentDigits && !baseLower.includes(apartmentDigits.toLowerCase())) {
      parts.push(apartmentRaw.toLowerCase().startsWith('кв') ? apartmentRaw : `кв. ${apartmentRaw}`);
    }
  }
  return parts.filter(Boolean).join(', ') || null;
};

const normalizeExactDigits = (value: unknown, exactLength: number): string | null => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const digitsOnly = raw.replace(/[^\d]/g, '');
  if (digitsOnly.length === exactLength) return digitsOnly;
  const grouped = new RegExp(`(^|[^\\d])((?:\\d[\\s-]?){${exactLength}})(?=[^\\d]|$)`, 'g');
  for (const match of raw.matchAll(grouped)) {
    const candidate = String(match[2] || '').replace(/[^\d]/g, '');
    if (candidate.length === exactLength) return candidate;
  }
  return null;
};

const normalizeNameToken = (value: unknown): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map(token => token
      .split('-')
      .map(part => (part ? `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}` : ''))
      .join('-'))
    .join(' ');
};

const splitFullName = (value: unknown): { lastName: string | null; firstName: string | null; middleName: string | null } => {
  const parts = String(value || '').trim().split(/\s+/).map(normalizeNameToken).filter((p): p is string => !!p);
  if (parts.length === 0) return { lastName: null, firstName: null, middleName: null };
  if (parts.length === 1) return { lastName: parts[0], firstName: null, middleName: null };
  if (parts.length === 2) return { lastName: parts[0], firstName: parts[1], middleName: null };
  return { lastName: parts[0], firstName: parts[1], middleName: parts.slice(2).join(' ') };
};

const resolvePersonNameParts = (parsed: ParsedJson) => {
  const explicitLast = normalizeNameToken(valueFrom(parsed, ['surname', 'lastName', 'last_name']));
  const explicitFirst = normalizeNameToken(valueFrom(parsed, ['givenNames', 'firstName', 'first_name', 'name']));
  const explicitMiddle = normalizeNameToken(valueFrom(parsed, ['middleName', 'middle_name', 'patronymic']));
  const full = splitFullName(valueFrom(parsed, ['fullName', 'full_name', 'fio']));
  return {
    lastName: explicitLast || full.lastName,
    firstName: explicitFirst || full.firstName,
    middleName: explicitMiddle || full.middleName,
  };
};

export const mergeMissingNormalizedFields = (primary: IOcrNormalized, secondary: IOcrNormalized): IOcrNormalized => {
  const merged: Record<string, unknown> = { ...primary };
  for (const [key, value] of Object.entries(secondary)) {
    const current = merged[key];
    const hasCurrent = current !== null && current !== undefined && (typeof current !== 'string' || current.trim() !== '');
    if (!hasCurrent && value !== null && value !== undefined && String(value).trim() !== '') merged[key] = value;
  }
  return merged as IOcrNormalized;
};

export const shouldRunIdentifierFallback = (type: HrOcrType, normalized: IOcrNormalized): type is 'inn' | 'snils' => {
  if (type === 'inn') return !normalized.inn;
  if (type === 'snils') return !normalized.snils;
  return false;
};

const LOOKALIKE_CYRILLIC_TO_LATIN: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X',
};

const normalizePassportIdentifier = (value: unknown, maxLength = 16): string | null => {
  if (!value) return null;
  const normalized = String(value)
    .trim()
    .toUpperCase()
    .replace(/[АВЕКМНОРСТУХ]/g, ch => LOOKALIKE_CYRILLIC_TO_LATIN[ch] ?? ch)
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, maxLength);
  return normalized || null;
};

const normalizeAlphaNumeric = (value: unknown, maxLength = 64): string | null => normalizePassportIdentifier(value, maxLength);

export const normalizeKigNumber = (value: unknown): string | null => {
  if (!value) return null;
  const raw = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const letters = raw.replace(/[^A-Z]/g, '');
  const digits = raw.replace(/[^\d]/g, '');
  if (letters.length < 2 || digits.length < 7) return null;
  return `${letters.slice(0, 2)}${digits.slice(0, 7)}`.slice(0, 9) || null;
};

const normalizeBlankIdentifier = (value: unknown): string | null => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-ZА-ЯЁ0-9]/g, '');
  const match = normalized.match(/[A-ZА-ЯЁ]{2}\d{6,8}/);
  return match ? match[0] : null;
};

const normalizeLookupKey = (value: unknown): string => String(value || '').trim().toLowerCase().replace(/[^a-zа-яё0-9]/g, '');

export const valueFrom = (obj: ParsedJson | null | undefined, aliases: string[]): string | null => {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of aliases) {
    const v = obj[key];
    if (v !== undefined && v !== null) {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  const entries = Object.entries(obj);
  const normalizedAliases = aliases.map(normalizeLookupKey).filter(Boolean);
  for (const alias of normalizedAliases) {
    for (const [objKey, objValue] of entries) {
      if (objValue === undefined || objValue === null) continue;
      if (normalizeLookupKey(objKey) === alias) {
        const s = String(objValue).trim();
        if (s) return s;
      }
    }
  }
  for (const alias of normalizedAliases) {
    if (alias.length < 7) continue;
    for (const [objKey, objValue] of entries) {
      if (objValue === undefined || objValue === null) continue;
      const k = normalizeLookupKey(objKey);
      if (k && k.includes(alias)) {
        const s = String(objValue).trim();
        if (s) return s;
      }
    }
  }
  return null;
};

const splitPassportNumber = (combined: string | null): { series: string | null; number: string | null } => {
  if (!combined) return { series: null, number: null };
  const digitsOnly = combined.replace(/\D/g, '');
  if (digitsOnly.length >= 10) return { series: digitsOnly.slice(0, 4), number: digitsOnly.slice(4, 10) };
  if (digitsOnly.length > 0 && digitsOnly.length <= 6) return { series: null, number: digitsOnly };
  const parts = combined.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return { series: parts[0].replace(/\D/g, '') || null, number: parts.slice(1).join('').replace(/\D/g, '') || null };
  }
  return { series: null, number: digitsOnly || null };
};

// ─── Нормализаторы по типу ──────────────────────────────────────────────────

const NAME_FIELDS = (p: ParsedJson) => ({
  lastName: valueFrom(p, ['surname', 'lastName', 'last_name']),
  firstName: valueFrom(p, ['givenNames', 'firstName', 'first_name']),
  middleName: valueFrom(p, ['middleName', 'middle_name', 'patronymic']),
});

const normalizePassportRf = (p: ParsedJson): IOcrNormalized => {
  const rawSeries = valueFrom(p, ['passportSeries', 'passport_series', 'series']);
  const rawNumberOnly = valueFrom(p, ['passportNumberOnly', 'passport_number_only', 'numberOnly', 'number_only']);
  const combined = valueFrom(p, ['passportNumber', 'passport_number', 'number', 'seriesNumber', 'series_number']);
  const hasLetters = /[A-Za-zА-Яа-яЁё]/.test(`${rawSeries || ''}${rawNumberOnly || ''}${combined || ''}`);
  const nonRf = normalizePassportIdentifier(rawNumberOnly || combined || rawSeries, 16);
  const split = splitPassportNumber(combined);
  return {
    ...NAME_FIELDS(p),
    birthDate: normalizeDate(valueFrom(p, ['birthDate', 'birth_date', 'dateOfBirth'])),
    sex: normalizeSex(valueFrom(p, ['sex', 'gender'])),
    citizenship: normalizeCitizenship(valueFrom(p, ['nationality', 'citizenship'])),
    passportSeries: hasLetters ? null : (normalizeDigits(rawSeries, 4) || split.series),
    passportNumber: hasLetters ? nonRf : (normalizeDigits(rawNumberOnly, 6) || normalizeDigits(split.number, 6)),
    passportIssuedAt: normalizeDate(valueFrom(p, ['issueDate', 'issue_date', 'passportIssueDate'])),
    passportIssuedBy: valueFrom(p, ['authority', 'issuedBy', 'passportIssuedBy']),
    passportDepartmentCode: valueFrom(p, ['departmentCode', 'department_code', 'passportDepartmentCode']),
    birthPlace: valueFrom(p, ['birthPlace', 'birth_place']),
    passportExpiryDate: normalizeDate(valueFrom(p, ['expiryDate', 'expiry_date', 'passportExpiryDate'])),
  };
};

const normalizeForeignPassport = (p: ParsedJson): IOcrNormalized => ({
  // ФИО из оригинала иностранного паспорта (латиница/MRZ) в карточку НЕ попадают —
  // источник ФИО только passport_translation.
  lastName: null,
  firstName: null,
  middleName: null,
  birthDate: normalizeDate(valueFrom(p, ['birthDate', 'birth_date', 'dateOfBirth'])),
  sex: normalizeSex(valueFrom(p, ['sex', 'gender'])),
  citizenship: normalizeCitizenship(valueFrom(p, ['nationality', 'citizenship'])),
  passportSeries: null,
  passportNumber: normalizeAlphaNumeric(valueFrom(p, ['passportNumber', 'passport_number', 'number', 'documentNumber', 'document_number']), 16),
  passportIssuedAt: normalizeDate(valueFrom(p, ['issueDate', 'issue_date', 'passportIssueDate'])),
  passportIssuedBy: valueFrom(p, ['authority', 'issuedBy', 'passportIssuedBy']),
  passportDepartmentCode: valueFrom(p, ['departmentCode', 'department_code', 'passportDepartmentCode']),
  birthPlace: valueFrom(p, ['birthPlace', 'birth_place']),
  passportExpiryDate: normalizeDate(valueFrom(p, ['expiryDate', 'expiry_date', 'passportExpiryDate'])),
});

const normalizePassportTranslation = (p: ParsedJson): IOcrNormalized => ({
  ...NAME_FIELDS(p),
  birthDate: normalizeDate(valueFrom(p, ['birthDate', 'birth_date', 'dateOfBirth'])),
  sex: normalizeSex(valueFrom(p, ['sex', 'gender'])),
  citizenship: normalizeCitizenship(valueFrom(p, ['nationality', 'citizenship'])),
  passportSeries: null,
  passportNumber: normalizeAlphaNumeric(valueFrom(p, ['passportNumber', 'passport_number', 'number', 'documentNumber', 'document_number']), 16),
  passportIssuedAt: normalizeDate(valueFrom(p, ['issueDate', 'issue_date', 'passportIssueDate'])),
  passportIssuedBy: valueFrom(p, ['authority', 'issuedBy', 'passportIssuedBy']),
  passportDepartmentCode: null,
  birthPlace: valueFrom(p, ['birthPlace', 'birth_place']),
  passportExpiryDate: normalizeDate(valueFrom(p, ['expiryDate', 'expiry_date', 'passportExpiryDate'])),
  registrationAddress: valueFrom(p, ['registrationAddress', 'registration_address', 'residenceAddress', 'residence_address', 'placeOfResidence', 'place_of_residence']),
});

const normalizePatent = (p: ParsedJson): IOcrNormalized => {
  const rawPatentNumber = valueFrom(p, ['patentNumber', 'patent_number', 'number', 'documentNumber', 'document_number', 'patentNo', 'patent_no', 'numberPatent', 'номерПатента', 'номер патента']);
  const rawBlankNumber = valueFrom(p, ['blankNumber', 'blank_number', 'blankNo', 'blank_no', 'blank', 'номерБланка', 'номер бланка', 'бланк']);
  const blank = normalizeBlankIdentifier(rawBlankNumber) || normalizeBlankIdentifier(rawPatentNumber);
  const patentDigits = normalizeDigits(rawPatentNumber, 12);
  const patentNumber = blank && patentDigits && patentDigits.length <= 8 ? null : patentDigits;
  return {
    ...NAME_FIELDS(p),
    birthDate: normalizeDate(valueFrom(p, ['birthDate', 'birth_date', 'dateOfBirth'])),
    citizenship: normalizeCitizenship(valueFrom(p, ['nationality', 'citizenship'])),
    patentNumber,
    patentIssueDate: normalizeDate(valueFrom(p, ['issueDate', 'issue_date', 'patentIssueDate', 'dateIssue', 'date_issue', 'issuedAt', 'issued_at', 'dateOfIssue', 'date_of_issue', 'датаВыдачи', 'дата выдачи'])),
    patentExpiryDate: normalizeDate(valueFrom(p, ['expiryDate', 'expiry_date', 'patentExpiryDate', 'dateExpiry', 'date_expiry', 'validUntil', 'valid_until', 'датаОкончания', 'дата окончания', 'действителенДо', 'действителен до'])),
    blankNumber: blank,
  };
};

const normalizeKig = (p: ParsedJson): IOcrNormalized => ({
  ...NAME_FIELDS(p),
  birthDate: normalizeDate(valueFrom(p, ['birthDate', 'birth_date', 'dateOfBirth'])),
  sex: normalizeSex(valueFrom(p, ['sex', 'gender'])),
  citizenship: normalizeCitizenship(valueFrom(p, ['nationality', 'citizenship'])),
  kig: normalizeKigNumber(valueFrom(p, ['kigNumber', 'kig_number', 'number'])),
  kigEndDate: normalizeDate(valueFrom(p, ['expiryDate', 'expiry_date', 'kigExpiryDate', 'validUntil', 'valid_until'])),
});

const normalizeInn = (p: ParsedJson): IOcrNormalized => ({
  ...resolvePersonNameParts(p),
  birthDate: normalizeDate(valueFrom(p, ['birthDate', 'birth_date', 'dateOfBirth', 'date_of_birth'])),
  inn: normalizeExactDigits(valueFrom(p, ['inn', 'innNumber', 'inn_number', 'documentNumber', 'document_number', 'number', 'certificateNumber', 'certificate_number']), 12),
});

const normalizeSnils = (p: ParsedJson): IOcrNormalized => ({
  ...resolvePersonNameParts(p),
  birthDate: normalizeDate(valueFrom(p, ['birthDate', 'birth_date', 'dateOfBirth', 'date_of_birth'])),
  snils: normalizeExactDigits(valueFrom(p, ['snils', 'snilsNumber', 'snils_number', 'documentNumber', 'document_number', 'number']), 11),
});

const normalizeBankDetails = (p: ParsedJson): IOcrNormalized => ({
  ...NAME_FIELDS(p),
  bankAccountNumber: normalizeDigits(valueFrom(p, ['bankAccountNumber', 'accountNumber', 'account', 'raschetniySchet']), 20),
  bankName: valueFrom(p, ['bankName', 'bank', 'name']),
  bankInn: normalizeDigits(valueFrom(p, ['inn', 'bankInn', 'bank_inn']), 12),
  bankBik: normalizeDigits(valueFrom(p, ['bik', 'bankBik', 'bank_bik']), 9),
  bankCorrAccount: normalizeDigits(valueFrom(p, ['corrAccount', 'correspondentAccount', 'ks']), 20),
});

const normalizeInsurancePolicy = (p: ParsedJson): IOcrNormalized => ({
  insurancePolicyNumber: valueFrom(p, ['policyNumber', 'policy_number', 'number', 'seriesNumber']),
  insurancePolicyDate: normalizeDate(valueFrom(p, ['issueDate', 'issue_date', 'startDate', 'validFrom'])),
});

const normalizeRegistrationAmina = (p: ParsedJson): IOcrNormalized => ({
  registrationAddress: buildRegistrationAddress(p),
  phone: normalizePhone(valueFrom(p, ['phone', 'phoneNumber', 'phone_number', 'mobilePhone', 'mobile_phone', 'номер телефона', 'телефон'])),
});

const normalizeVisa = (p: ParsedJson): IOcrNormalized => ({
  lastName: valueFrom(p, ['surname', 'lastName', 'last_name']),
  firstName: valueFrom(p, ['givenNames', 'firstName', 'first_name']),
  birthDate: normalizeDate(valueFrom(p, ['birthDate', 'birth_date', 'dateOfBirth'])),
  citizenship: normalizeCitizenship(valueFrom(p, ['nationality', 'citizenship'])),
  visaNumber: normalizeAlphaNumeric(valueFrom(p, ['visaNumber', 'visa_number', 'number']), 16),
  visaIssueDate: normalizeDate(valueFrom(p, ['issueDate', 'issue_date', 'visaIssueDate'])),
  visaExpiryDate: normalizeDate(valueFrom(p, ['expiryDate', 'expiry_date', 'visaExpiryDate'])),
});

export const normalizeResponseByType = (type: HrOcrType, parsed: ParsedJson): IOcrNormalized => {
  switch (type) {
    case 'passport_rf': return normalizePassportRf(parsed);
    case 'foreign_passport': return normalizeForeignPassport(parsed);
    case 'passport_translation': return normalizePassportTranslation(parsed);
    case 'patent': return normalizePatent(parsed);
    case 'kig':
    case 'kig_back': return normalizeKig(parsed);
    case 'inn': return normalizeInn(parsed);
    case 'snils': return normalizeSnils(parsed);
    case 'bank_details': return normalizeBankDetails(parsed);
    case 'visa': return normalizeVisa(parsed);
    case 'insurance_policy': return normalizeInsurancePolicy(parsed);
    case 'registration_amina': return normalizeRegistrationAmina(parsed);
    default: return {};
  }
};

// ─── Парсер ответа ──────────────────────────────────────────────────────────

const extractJsonText = (raw: string): string | null => {
  if (!raw) return null;
  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return raw.slice(first, last + 1);
};

const CONTROL_CHARS_RE = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12)
    + String.fromCharCode(14) + "-" + String.fromCharCode(31) + "]",
  "g",
);
const stripInvalidControlChars = (value = ""): string => String(value).replace(CONTROL_CHARS_RE, "");

const coerceScalar = (rawValue: string): unknown => {
  if (rawValue === 'null') return null;
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) return Number(rawValue);
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue.replace(/^"|"$/g, '');
  }
};

const tryParseKeyValuePairs = (text = ''): ParsedJson | null => {
  const parsed: ParsedJson = {};
  const pairRegex = /"?([A-Za-zА-Яа-яЁё0-9_.\-\s]+)"?\s*[:=]\s*("(?:[^"\\]|\\.)*"|null|true|false|-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = pairRegex.exec(text)) !== null) {
    const key = String(match[1] || '').trim();
    if (!key) continue;
    parsed[key] = coerceScalar(String(match[2] || '').trim());
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
};

const tryParseLineKeyValuePairs = (text = ''): ParsedJson | null => {
  const parsed: ParsedJson = {};
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^["']?(.+?)["']?\s*(?::|=|\s[-–—]\s)\s*(.+?)\s*,?$/);
    if (!match) continue;
    const key = String(match[1] || '').trim();
    let rawValue = String(match[2] || '').trim();
    if (!key || !rawValue) continue;
    if (rawValue.endsWith(',')) rawValue = rawValue.slice(0, -1).trim();
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      const unquoted = rawValue.slice(1, -1);
      try {
        parsed[key] = JSON.parse(`"${unquoted.replace(/"/g, '\\"')}"`);
      } catch {
        parsed[key] = unquoted;
      }
      continue;
    }
    parsed[key] = coerceScalar(rawValue);
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
};

export const parseStructuredJson = (content: string): ParsedJson | null => {
  const jsonText = extractJsonText(content);
  if (!jsonText) return tryParseLineKeyValuePairs(content);
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ParsedJson) : null;
  } catch {
    const sanitized = stripInvalidControlChars(jsonText).replace(/,\s*([}\]])/g, '$1').trim();
    try {
      const parsed = JSON.parse(sanitized) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ParsedJson) : null;
    } catch {
      return tryParseKeyValuePairs(sanitized) || tryParseLineKeyValuePairs(sanitized);
    }
  }
};

export const hasMeaningfulNormalizedData = (normalized: IOcrNormalized): boolean =>
  Object.values(normalized).some(value => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  });

// ─── Quality gate / обязательные поля ───────────────────────────────────────

const nonEmpty = (v: unknown): boolean => v !== null && v !== undefined && String(v).trim().length > 0;

/**
 * Перевод паспорта считается валидным только при ФИО (фамилия+имя) И хотя бы одном
 * «якоре» — защита от галлюцинаций ФИО на нечитаемом скане.
 */
export const passesPassportTranslationQualityGate = (n: IOcrNormalized): boolean => {
  if (!nonEmpty(n.lastName) || !nonEmpty(n.firstName)) return false;
  return [n.birthDate, n.passportNumber, n.citizenship, n.passportIssuedAt, n.passportExpiryDate].some(nonEmpty);
};

export const passesQualityGate = (type: HrOcrType, n: IOcrNormalized): boolean =>
  type === 'passport_translation' ? passesPassportTranslationQualityGate(n) : true;

export const getMissingRequiredOcrFields = (type: HrOcrType, n: IOcrNormalized): string[] => {
  if (type === 'snils') return nonEmpty(n.snils) ? [] : ['snils'];
  if (type === 'passport_translation') return passesPassportTranslationQualityGate(n) ? [] : ['passport_translation_quality'];
  return [];
};
