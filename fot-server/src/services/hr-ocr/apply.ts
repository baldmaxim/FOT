/**
 * Применение распознанного к профилю. Порт PassDesk
 * client/src/modules/employees/lib/employeeOcrUtils.js (buildFormPatchFromOcr,
 * buildOcrApplyPlan, normalizeFormValueForCompare, resolveCitizenshipIdByOcrCode).
 *
 * Правило: пустое поле профиля → автозаполнение; непустое и отличающееся (после
 * нормализации) → конфликт с ручным «Применить / Отклонить».
 */
import type { IOcrNormalized } from './normalize.js';
import { normalizeKigNumber } from './normalize.js';
import { normalizeDocNumber } from '../hr-crypto.service.js';

/** Патч полей профиля (ключи как в HR_PROFILE_FIELDS + ФИО для мастера). */
export type HrOcrPatch = Record<string, string | null>;

export interface ICitizenshipRow {
  id: string;
  name: string;
  iso_code: string | null;
  synonyms?: string[];
}

const normalizeString = (v: unknown): string => String(v ?? '').trim();
const toDigits = (v: unknown, max = 64): string => normalizeString(v).replace(/[^\d]/g, '').slice(0, max);

const toDisplayName = (v: unknown): string | null => {
  const s = normalizeString(v);
  if (!s) return null;
  return s
    .toLowerCase()
    .split(/(\s|-)/)
    .map(part => (part === ' ' || part === '-' ? part : part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join('');
};

export const formatPhone = (v: unknown): string | null => {
  const digits = toDigits(v, 11);
  if (!digits) return null;
  let normalized = digits;
  if (normalized.length === 10) normalized = `7${normalized}`;
  else if (normalized.length === 11 && normalized.startsWith('8')) normalized = `7${normalized.slice(1)}`;
  if (!(normalized.length === 11 && normalized.startsWith('7'))) return normalizeString(v) || null;
  return `+7 (${normalized.slice(1, 4)}) ${normalized.slice(4, 7)}-${normalized.slice(7, 9)}-${normalized.slice(9, 11)}`;
};

export const formatSnils = (v: unknown): string | null => {
  const d = toDigits(v, 11);
  if (!d) return null;
  if (d.length < 4) return d;
  if (d.length < 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length < 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)} ${d.slice(9, 11)}`;
};

export const formatInn = (v: unknown): string | null => {
  const d = toDigits(v, 12);
  return d || null;
};

export const formatPatentNumber = (v: unknown): string | null => {
  const d = toDigits(v, 12);
  if (!d) return null;
  if (d.length <= 2) return d;
  return `${d.slice(0, 2)} №${d.slice(2)}`;
};

export const formatBlankNumber = (v: unknown): string | null => {
  const raw = normalizeString(v).toUpperCase();
  if (!raw) return null;
  const letters = raw.replace(/[^A-ZА-ЯЁ]/g, '').slice(0, 2);
  const digits = raw.replace(/[^\d]/g, '').slice(0, 7);
  return `${letters}${digits}` || null;
};

const formatPassportNumber = (series: unknown, number: unknown): string | null => {
  const s = toDigits(series, 4);
  const n = toDigits(number, 6);
  if (s.length === 4 && n.length === 6) return `${s} ${n}`;
  return null;
};

const formatDepartmentCode = (v: unknown): string | null => {
  const d = toDigits(v, 6);
  if (d.length !== 6) return normalizeString(v) || null;
  return `${d.slice(0, 3)}-${d.slice(3)}`;
};

const mapSexToGender = (v: unknown): 'male' | 'female' | null => {
  const n = normalizeString(v).toUpperCase();
  if (['M', 'MALE', 'М', 'МУЖ', 'МУЖ.', 'МУЖСКОЙ', 'МУЖЧИНА'].includes(n)) return 'male';
  if (['F', 'FEMALE', 'Ж', 'ЖЕН', 'ЖЕН.', 'ЖЕНСКИЙ', 'ЖЕНЩИНА'].includes(n)) return 'female';
  return null;
};

const normalizeCitizenshipLookup = (v: unknown): string =>
  normalizeString(v).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();

/** Гражданство из OCR (ISO3/название/синоним) → строка справочника hr_citizenships. */
export const resolveCitizenshipByOcr = (rows: ICitizenshipRow[], ocrValue: unknown): ICitizenshipRow | null => {
  const raw = normalizeString(ocrValue);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const byIso = rows.find(r => r.iso_code && r.iso_code.toUpperCase() === upper);
  if (byIso) return byIso;

  const lookup = normalizeCitizenshipLookup(raw);
  const matches = (row: ICitizenshipRow, candidate: string): boolean => {
    if (!candidate) return false;
    const name = normalizeCitizenshipLookup(row.name);
    if (name === candidate || name.includes(candidate) || candidate.includes(name)) return true;
    return (row.synonyms ?? []).some(syn => {
      const s = normalizeCitizenshipLookup(syn);
      return s === candidate || s.includes(candidate) || candidate.includes(s);
    });
  };
  const byName = rows.find(r => matches(r, lookup));
  if (byName) return byName;

  const parts = lookup.split(/[/,|\s]+/).filter(p => p.length >= 2);
  for (const part of parts) {
    const byPartIso = rows.find(r => r.iso_code && r.iso_code.toLowerCase() === part);
    if (byPartIso) return byPartIso;
    const byPart = rows.find(r => matches(r, part));
    if (byPart) return byPart;
  }
  return null;
};

/**
 * Нормализованный результат → патч полей профиля/сотрудника. Гражданство — как
 * `citizenship_id`, если нашлось в справочнике, плюс сырое значение `citizenship_raw`.
 */
export const buildProfilePatchFromOcr = (n: IOcrNormalized, citizenships: ICitizenshipRow[]): HrOcrPatch => {
  const patch: HrOcrPatch = {};
  const set = (key: string, value: string | null | undefined): void => {
    if (value !== null && value !== undefined && String(value).trim()) patch[key] = String(value).trim();
  };

  set('last_name', toDisplayName(n.lastName));
  set('first_name', toDisplayName(n.firstName));
  set('middle_name', toDisplayName(n.middleName));
  set('birth_date', n.birthDate);
  set('gender', mapSexToGender(n.sex));

  const citizenship = resolveCitizenshipByOcr(citizenships, n.citizenship);
  if (citizenship) {
    set('citizenship_id', citizenship.id);
    set('birth_country_id', citizenship.id);
  } else if (n.citizenship) {
    set('citizenship_raw', n.citizenship);
  }

  const passport = formatPassportNumber(n.passportSeries, n.passportNumber);
  set('passport_number', passport || (n.passportNumber ? normalizeString(n.passportNumber) : null));
  if (n.passportSeries && n.passportNumber && passport) set('passport_type', 'russian');
  set('passport_date', n.passportIssuedAt);
  set('passport_expiry_date', n.passportExpiryDate);
  set('passport_issuer', n.passportIssuedBy);
  set('passport_department_code', n.passportDepartmentCode ? formatDepartmentCode(n.passportDepartmentCode) : null);
  set('birth_city', n.birthPlace);
  set('registration_address', n.registrationAddress);
  set('phone', formatPhone(n.phone));
  set('inn', formatInn(n.inn));
  set('snils', formatSnils(n.snils));
  set('kig', normalizeKigNumber(n.kig));
  set('kig_end_date', n.kigEndDate);
  set('patent_number', formatPatentNumber(n.patentNumber));
  set('patent_issue_date', n.patentIssueDate);
  set('patent_expiry_date', n.patentExpiryDate);
  set('patent_blank_number', formatBlankNumber(n.blankNumber));
  set('bank_account_number', toDigits(n.bankAccountNumber, 20) || null);
  set('bank_bik', toDigits(n.bankBik, 9) || null);
  set('insurance_policy_number', n.insurancePolicyNumber);
  set('insurance_policy_date', n.insurancePolicyDate);
  return patch;
};

const DATE_FIELDS = new Set(['birth_date', 'passport_date', 'passport_expiry_date', 'kig_end_date', 'patent_issue_date', 'patent_expiry_date', 'insurance_policy_date', 'planned_exit_date']);

export const isEmptyFormValue = (v: unknown): boolean => v === null || v === undefined || normalizeString(v) === '';

/** Сравнимое представление значения поля (для конфликтов). */
export const normalizeForCompare = (field: string, value: unknown): string => {
  if (isEmptyFormValue(value)) return '';
  if (DATE_FIELDS.has(field)) return normalizeString(value).slice(0, 10);
  switch (field) {
    case 'phone': return toDigits(value, 11).replace(/^8/, '7');
    case 'passport_number': return normalizeDocNumber(String(value)) ?? '';
    case 'passport_department_code': return toDigits(value, 6);
    case 'inn': return toDigits(value, 12);
    case 'snils': return toDigits(value, 11);
    case 'kig': return normalizeKigNumber(value) || '';
    case 'patent_number': return toDigits(value, 12);
    case 'patent_blank_number': return normalizeString(value).toUpperCase().replace(/[^A-ZА-ЯЁ0-9]/g, '');
    case 'bank_account_number': return toDigits(value, 20);
    case 'bank_bik': return toDigits(value, 9);
    case 'citizenship_id':
    case 'birth_country_id':
    case 'gender':
    case 'passport_type': return normalizeString(value).toLowerCase();
    default: return normalizeString(value).toLowerCase().replace(/\s+/g, ' ');
  }
};

export interface IOcrConflict {
  fieldName: string;
  currentValue: string;
  ocrValue: string;
}

export interface IOcrApplyPlan {
  autoFill: HrOcrPatch;
  conflicts: IOcrConflict[];
}

/** Пустое → автозаполнение; непустое и отличающееся → конфликт. */
export const buildOcrApplyPlan = (
  currentValues: Record<string, unknown>,
  ocrPatch: HrOcrPatch,
  opts?: { skipFields?: string[] },
): IOcrApplyPlan => {
  const skip = new Set(opts?.skipFields ?? []);
  const autoFill: HrOcrPatch = {};
  const conflicts: IOcrConflict[] = [];
  for (const [field, ocrValue] of Object.entries(ocrPatch)) {
    if (skip.has(field) || isEmptyFormValue(ocrValue)) continue;
    const current = currentValues[field];
    if (isEmptyFormValue(current)) {
      autoFill[field] = ocrValue;
      continue;
    }
    if (normalizeForCompare(field, current) !== normalizeForCompare(field, ocrValue)) {
      conflicts.push({ fieldName: field, currentValue: String(current), ocrValue: String(ocrValue) });
    }
  }
  return { autoFill, conflicts };
};

/** Поля, которые НЕ применяем из документов этого типа (ФИО иностранца — только из перевода). */
export const FIO_FIELDS = ['last_name', 'first_name', 'middle_name'];
