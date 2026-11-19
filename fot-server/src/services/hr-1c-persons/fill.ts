/**
 * Что из 1С можно записать в карточку: только пустое в FOT, расхождения — в отчёт.
 *
 * Пустота шифрованного поля — по сырому `*_enc IS NULL`. Если шифротекст есть, он
 * расшифровывается строго и сверяется со своим хэшем: ошибка — HrIntegrityError, а не
 * «пусто» (decryptFieldSafe вернул бы null, и поле перезаписалось бы).
 * Паспорт (6 полей), патент (номер + дата) и КИГ — блоки: расхождение любого поля блока
 * → блок не пишется целиком, чтобы не собрать, например, тип «РФ» с иностранным номером.
 */
import { HR_PROFILE_FIELDS } from '../../config/hr-documents.js';
import { decryptField, hashForSearch, normalizeDocNumber, type HrHashField } from '../hr-crypto.service.js';
import { getCitizenshipById, type IHrCitizenship, type IHrProfileInput } from '../hr-profile.service.js';
import type { IDb } from './facts.js';
import { isValidPersonInn, isValidSnils, normalizePhone1c, type IPerson1c } from './parse.js';

export class HrIntegrityError extends Error {
  constructor(field: string) {
    super(`Поле «${field}» в FOT не расшифровывается или не совпадает со своим хэшем — карточка пропущена`);
    this.name = 'HrIntegrityError';
  }
}

export const FILL_FIELDS = [
  'birth_date', 'snils', 'inn', 'citizenship_id',
  'passport_type', 'passport_number', 'passport_date', 'passport_issuer', 'passport_department_code', 'passport_expiry_date',
  'kig', 'patent_number', 'patent_issue_date', 'registration_address', 'phone',
] as const;
export type FillField = typeof FILL_FIELDS[number];

const BLOCKS: Record<'passport' | 'patent' | 'kig', FillField[]> = {
  passport: ['passport_type', 'passport_number', 'passport_date', 'passport_issuer', 'passport_department_code', 'passport_expiry_date'],
  patent: ['patent_number', 'patent_issue_date'],
  kig: ['kig'],
};
const SINGLE: FillField[] = ['birth_date', 'snils', 'inn', 'citizenship_id', 'registration_address', 'phone'];

export const fieldLabel = (key: string): string =>
  key === 'passdesk_id_all' ? 'Код 1С' : HR_PROFILE_FIELDS.find(f => f.key === key)?.label ?? key;

export interface ICurrentState {
  employeeId: number;
  hasProfile: boolean;
  zupIsUploaded: boolean;
  passdeskIdAll: string | null;
  country: string | null;
  citizenshipName: string | null;
  values: Record<FillField, string | null>;
}

export interface IDiff {
  field: FillField;
  value1c: string;
  valueFot: string;
  note: string | null;
}

export interface IFillPlan {
  input: IHrProfileInput;
  fields: FillField[];
  diffs: IDiff[];
  skippedBlocks: Array<keyof typeof BLOCKS>;
  notes: string[];
}

const ENC: Partial<Record<FillField, { enc: string; hash: string; hashField: HrHashField }>> = {
  inn: { enc: 'inn_enc', hash: 'inn_hash', hashField: 'inn' },
  passport_number: { enc: 'passport_number_enc', hash: 'passport_number_hash', hashField: 'passport' },
  kig: { enc: 'kig_enc', hash: 'kig_hash', hashField: 'kig' },
  patent_number: { enc: 'patent_number_enc', hash: 'patent_number_hash', hashField: 'patent' },
};

const strictDecrypt = (row: Record<string, unknown>, field: FillField): string | null => {
  const meta = ENC[field]!;
  const enc = row[meta.enc] as string | null;
  if (enc === null || enc === undefined) return null;
  try {
    const plain = decryptField(enc);
    const stored = (row[meta.hash] as string | null)?.trim() ?? null;
    if (!plain || !stored || hashForSearch(meta.hashField, plain) !== stored) throw new Error('hash');
    return plain;
  } catch {
    throw new HrIntegrityError(fieldLabel(field));
  }
};

/**
 * Текущие значения карточки. При записи — `lock: true` (FOR UPDATE карточки и профиля);
 * в предпросмотре (read-only сессия) — без блокировки.
 */
export const loadCurrentState = async (db: IDb, employeeId: number, opts: { lock: boolean }): Promise<ICurrentState> => {
  const lock = opts.lock ? ' FOR UPDATE' : '';
  const emp = (await db.query<{ birth_date: string | null; pension_number: string | null; patent_issue_date: string | null; country: string | null }>(
    `SELECT birth_date::text AS birth_date, pension_number, patent_issue_date::text AS patent_issue_date, country
       FROM employees WHERE id = $1${lock}`, [employeeId])).rows[0];
  if (!emp) throw new Error(`Сотрудник #${employeeId} не найден`);
  const profile = (await db.query<Record<string, unknown>>(
    `SELECT p.*, p.passport_date::text AS passport_date_t, p.passport_expiry_date::text AS passport_expiry_date_t,
            p.passdesk_id_all::text AS passdesk_id_all_t, p.citizenship_id::text AS citizenship_id_t
       FROM employee_hr_profiles p WHERE p.employee_id = $1${lock}`, [employeeId])).rows[0] ?? null;
  const p = (k: string): string | null => {
    const v = profile?.[k];
    return v === null || v === undefined || v === '' ? null : String(v);
  };
  const snils = (emp.pension_number ?? '').replace(/\D/g, '');
  const citizenshipId = p('citizenship_id_t');
  return {
    employeeId,
    hasProfile: profile !== null,
    zupIsUploaded: profile?.zup_is_uploaded === true,
    passdeskIdAll: p('passdesk_id_all_t'),
    country: emp.country?.trim() || null,
    citizenshipName: citizenshipId ? (await getCitizenshipById(citizenshipId))?.name ?? null : null,
    values: {
      birth_date: emp.birth_date,
      snils: snils || null,
      inn: profile ? strictDecrypt(profile, 'inn') : null,
      citizenship_id: citizenshipId,
      passport_type: p('passport_type'),
      passport_number: profile ? strictDecrypt(profile, 'passport_number') : null,
      passport_date: p('passport_date_t'),
      passport_issuer: p('passport_issuer'),
      passport_department_code: p('passport_department_code'),
      passport_expiry_date: p('passport_expiry_date_t'),
      kig: profile ? strictDecrypt(profile, 'kig') : null,
      patent_number: profile ? strictDecrypt(profile, 'patent_number') : null,
      patent_issue_date: emp.patent_issue_date,
      registration_address: p('registration_address'),
      phone: p('phone'),
    },
  };
};

/** Значения 1С в ключах полей FOT. */
export const values1c = (person: IPerson1c, citizenship: IHrCitizenship | null): Record<FillField, string | null> => ({
  birth_date: person.birthDate,
  snils: person.snils,
  inn: person.inn,
  citizenship_id: citizenship?.id ?? null,
  passport_type: person.passport?.type ?? null,
  passport_number: person.passport?.number ?? null,
  passport_date: person.passport?.date ?? null,
  passport_issuer: person.passport?.issuer ?? null,
  passport_department_code: person.passport?.departmentCode ?? null,
  passport_expiry_date: person.passport?.expiryDate ?? null,
  kig: person.kig,
  patent_number: person.patent?.number ?? null,
  patent_issue_date: person.patent?.issueDate ?? null,
  registration_address: person.registrationAddress,
  phone: person.phone,
});

const digitsOnly = (s: string): string => s.replace(/\D/g, '');
const textKey = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]/g, '');

/** Одинаковы ли значения поля с точностью до формата. */
export const sameValue = (field: FillField, a: string, b: string): boolean => {
  switch (field) {
    case 'passport_number': case 'kig': case 'patent_number': return normalizeDocNumber(a) === normalizeDocNumber(b);
    case 'phone': return (normalizePhone1c(a) ?? digitsOnly(a)) === (normalizePhone1c(b) ?? digitsOnly(b));
    case 'snils': case 'inn': case 'passport_department_code': return digitsOnly(a) === digitsOnly(b);
    case 'passport_issuer': case 'registration_address': return textKey(a) === textKey(b);
    default: return a === b;
  }
};

const checksumNote = (field: FillField, v1c: string, vFot: string): string | null => {
  const check = field === 'snils' ? isValidSnils : field === 'inn' ? isValidPersonInn : null;
  if (!check) return null;
  const ok = (v: string): string => (check(digitsOnly(v)) ? 'верна' : 'неверна');
  return `контрольная сумма: 1С — ${ok(v1c)}, FOT — ${ok(vFot)}`;
};

/** План записи: только пустые поля; блок с расхождением — целиком в отчёт. */
export const planFill = (person: IPerson1c, current: ICurrentState, citizenship: IHrCitizenship | null): IFillPlan => {
  const next = values1c(person, citizenship);
  const cur = current.values;
  const fields: FillField[] = [];
  const diffs: IDiff[] = [];
  const skippedBlocks: IFillPlan['skippedBlocks'] = [];
  const notes: string[] = [];

  const diffOf = (f: FillField): IDiff | null => {
    const a = next[f];
    const b = cur[f];
    if (!a || !b || sameValue(f, a, b)) return null;
    if (f === 'citizenship_id') return { field: f, value1c: citizenship?.name ?? a, valueFot: current.citizenshipName ?? b, note: null };
    return { field: f, value1c: a, valueFot: b, note: checksumNote(f, a, b) };
  };

  for (const f of SINGLE) {
    const d = diffOf(f);
    if (d) { diffs.push(d); continue; }
    if (!next[f] || cur[f]) continue;
    if (f === 'citizenship_id' && current.country && current.country.toUpperCase() !== citizenship!.name.toUpperCase()) {
      // Write-through перезаписал бы employees.country — оставляем как есть.
      diffs.push({ field: f, value1c: citizenship!.name, valueFot: current.country, note: 'гражданство в карточке сотрудника' });
      continue;
    }
    fields.push(f);
  }
  if (person.citizenship && !citizenship) notes.push('гражданства из 1С нет в справочнике FOT — не заносится');

  for (const [block, list] of Object.entries(BLOCKS) as Array<[keyof typeof BLOCKS, FillField[]]>) {
    const blockDiffs = list.map(diffOf).filter((d): d is IDiff => d !== null);
    if (blockDiffs.length > 0) {
      diffs.push(...blockDiffs);
      if (list.some(f => next[f] && !cur[f])) skippedBlocks.push(block);
      continue;
    }
    for (const f of list) if (next[f] && !cur[f]) fields.push(f);
  }

  const input: IHrProfileInput = {};
  for (const f of fields) (input as Record<string, string | null>)[f] = next[f];
  return { input, fields, diffs, skippedBlocks, notes };
};
