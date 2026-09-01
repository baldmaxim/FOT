/**
 * Кадровый профиль («Реквизиты»): чтение с маскированием, запись с шифрованием,
 * write-through полей, принадлежащих employees, история, антидубль, ЗУП.
 *
 * Владение полями (план v3, §2): ФИО/дата рождения/СНИЛС(pension_number)/даты
 * патента/email — employees; остальное — employee_hr_profiles; гражданство —
 * профиль с зеркалом в employees.country.
 */
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import {
  HR_PROFILE_FIELDS,
  ZUP_RELEVANT_FIELDS,
  requiresPatent,
  resolveDocumentProfile,
  resolveDocumentSlots,
  type HrDocumentProfile,
} from '../config/hr-documents.js';
import {
  decryptFieldSafe,
  decryptJson,
  encryptField,
  encryptJson,
  getActiveHrKeyVersion,
  hashForSearch,
  maskValue,
  normalizeDigits,
  normalizeDocNumber,
  normalizeNameForHash,
} from './hr-crypto.service.js';

// ─── Справочник гражданств ──────────────────────────────────────────────────

export interface IHrCitizenship {
  id: string;
  name: string;
  iso_code: string | null;
  requires_patent: boolean;
  is_eaeu: boolean;
  is_active: boolean;
  sort_order: number;
  synonyms: string[];
}

const CITIZENSHIP_TTL_MS = 5 * 60_000;
let citizenshipCache: { rows: IHrCitizenship[]; expiresAt: number } | null = null;

export const invalidateCitizenshipCache = (): void => {
  citizenshipCache = null;
};

export const listCitizenships = async (): Promise<IHrCitizenship[]> => {
  if (citizenshipCache && citizenshipCache.expiresAt > Date.now()) return citizenshipCache.rows;
  const rows = await query<Omit<IHrCitizenship, 'synonyms'> & { synonyms: string[] | null }>(
    `SELECT c.id, c.name, c.iso_code, c.requires_patent, c.is_eaeu, c.is_active, c.sort_order,
            COALESCE(array_agg(s.synonym) FILTER (WHERE s.synonym IS NOT NULL), '{}') AS synonyms
       FROM hr_citizenships c
       LEFT JOIN hr_citizenship_synonyms s ON s.citizenship_id = c.id
      GROUP BY c.id
      ORDER BY c.sort_order, c.name`,
  );
  const normalized = rows.map(r => ({ ...r, synonyms: r.synonyms ?? [] }));
  citizenshipCache = { rows: normalized, expiresAt: Date.now() + CITIZENSHIP_TTL_MS };
  return normalized;
};

const normalizeLookup = (v: string): string => v.trim().toLowerCase().replace(/ё/g, 'е');

/** Название / ISO / синоним → строка справочника (для импорта и OCR). */
export const findCitizenshipByValue = async (value: string | null | undefined): Promise<IHrCitizenship | null> => {
  if (!value) return null;
  const rows = await listCitizenships();
  const lookup = normalizeLookup(String(value));
  if (!lookup) return null;
  return rows.find(r => normalizeLookup(r.name) === lookup)
    ?? rows.find(r => r.iso_code && r.iso_code.toLowerCase() === lookup)
    ?? rows.find(r => r.synonyms.some(s => normalizeLookup(s) === lookup))
    ?? null;
};

export const getCitizenshipById = async (id: string | null | undefined): Promise<IHrCitizenship | null> => {
  if (!id) return null;
  const rows = await listCitizenships();
  return rows.find(r => r.id === id) ?? null;
};

// ─── Модель ─────────────────────────────────────────────────────────────────

/** Строка employee_hr_profiles + связанные поля employees (JOIN). */
export interface IHrProfileRow {
  employee_id: number;
  citizenship_id: string | null;
  has_residence_permit: boolean;
  gender: 'male' | 'female' | null;
  birth_country_id: string | null;
  birth_region: string | null;
  birth_city: string | null;
  phone: string | null;
  passport_type: 'russian' | 'foreign' | null;
  passport_number_enc: string | null;
  passport_number_hash: string | null;
  passport_date: string | null;
  passport_issuer: string | null;
  passport_department_code: string | null;
  passport_expiry_date: string | null;
  registration_address: string | null;
  inn_enc: string | null;
  inn_hash: string | null;
  snils_hash: string | null;
  kig_enc: string | null;
  kig_hash: string | null;
  kig_end_date: string | null;
  patent_number_enc: string | null;
  patent_number_hash: string | null;
  patent_blank_number: string | null;
  insurance_policy_number: string | null;
  insurance_policy_date: string | null;
  bank_account_number_enc: string | null;
  bank_bik: string | null;
  planned_exit_date: string | null;
  notes: string | null;
  zup_is_uploaded: boolean;
  zup_uploaded_at: string | null;
  zup_marked_by: string | null;
  zup_exported_at: string | null;
  zup_exported_by: string | null;
  passdesk_id: string | null;
  passdesk_id_all: string | null;
  match_rule: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  // employees
  full_name: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  birth_date: string | null;
  email: string | null;
  pension_number: string | null;
  patent_issue_date: string | null;
  patent_expiry_date: string | null;
  employment_status: string;
  hire_date: string | null;
  org_department_id: string | null;
  tab_number: string | null;
}

/** Плоские редактируемые поля (ключи API). */
export interface IHrProfileInput {
  gender?: 'male' | 'female' | null;
  citizenship_id?: string | null;
  has_residence_permit?: boolean;
  birth_date?: string | null;
  birth_country_id?: string | null;
  birth_region?: string | null;
  birth_city?: string | null;
  registration_address?: string | null;
  email?: string | null;
  phone?: string | null;
  snils?: string | null;
  inn?: string | null;
  passport_type?: 'russian' | 'foreign' | null;
  passport_number?: string | null;
  passport_date?: string | null;
  passport_issuer?: string | null;
  passport_department_code?: string | null;
  passport_expiry_date?: string | null;
  bank_account_number?: string | null;
  bank_bik?: string | null;
  insurance_policy_number?: string | null;
  insurance_policy_date?: string | null;
  kig?: string | null;
  kig_end_date?: string | null;
  patent_number?: string | null;
  patent_issue_date?: string | null;
  patent_expiry_date?: string | null;
  patent_blank_number?: string | null;
  planned_exit_date?: string | null;
  notes?: string | null;
}

export type HrProfileFieldKey = keyof IHrProfileInput;

export const HR_INPUT_KEYS: readonly HrProfileFieldKey[] = HR_PROFILE_FIELDS.map(f => f.key as HrProfileFieldKey);

const EMPLOYEE_OWNED: Record<string, string> = {
  birth_date: 'birth_date',
  email: 'email',
  snils: 'pension_number',
  patent_issue_date: 'patent_issue_date',
  patent_expiry_date: 'patent_expiry_date',
};

const SENSITIVE_KEYS: readonly HrProfileFieldKey[] = ['inn', 'passport_number', 'bank_account_number', 'kig', 'patent_number', 'snils'];

const ENC_COLUMNS: Record<string, { enc: string; hash?: string; ver: string; hashField?: 'inn' | 'passport' | 'kig' | 'patent' }> = {
  inn: { enc: 'inn_enc', hash: 'inn_hash', ver: 'inn_key_version', hashField: 'inn' },
  passport_number: { enc: 'passport_number_enc', hash: 'passport_number_hash', ver: 'passport_key_version', hashField: 'passport' },
  kig: { enc: 'kig_enc', hash: 'kig_hash', ver: 'kig_key_version', hashField: 'kig' },
  patent_number: { enc: 'patent_number_enc', hash: 'patent_number_hash', ver: 'patent_key_version', hashField: 'patent' },
  bank_account_number: { enc: 'bank_account_number_enc', ver: 'bank_key_version' },
};

const PLAIN_PROFILE_COLUMNS: readonly HrProfileFieldKey[] = [
  'gender', 'citizenship_id', 'has_residence_permit', 'birth_country_id', 'birth_region', 'birth_city',
  'registration_address', 'phone', 'passport_type', 'passport_date', 'passport_issuer', 'passport_department_code',
  'passport_expiry_date', 'bank_bik', 'insurance_policy_number', 'insurance_policy_date', 'kig_end_date',
  'patent_blank_number', 'planned_exit_date', 'notes',
];

export interface IHrProfileView {
  employee_id: number;
  full_name: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  employment_status: string;
  hire_date: string | null;
  org_department_id: string | null;
  tab_number: string | null;
  citizenship: Pick<IHrCitizenship, 'id' | 'name' | 'iso_code' | 'requires_patent' | 'is_eaeu'> | null;
  birth_country: Pick<IHrCitizenship, 'id' | 'name'> | null;
  requires_patent: boolean;
  document_profile: HrDocumentProfile;
  document_slots: { all: string[]; required: string[] };
  masked: boolean;
  fields: Record<HrProfileFieldKey, string | boolean | null>;
  zup: {
    is_uploaded: boolean;
    uploaded_at: string | null;
    marked_by: string | null;
    exported_at: string | null;
  };
  passdesk_id: string | null;
  match_rule: string | null;
  created_at: string;
  updated_at: string;
}

const PROFILE_SELECT = `
  p.*,
  e.full_name, e.last_name, e.first_name, e.middle_name, e.birth_date, e.email, e.pension_number,
  e.patent_issue_date, e.patent_expiry_date, e.employment_status, e.hire_date, e.org_department_id, e.tab_number`;

export const loadProfileRow = async (employeeId: number, client?: PoolClient): Promise<IHrProfileRow | null> => {
  const sql = `SELECT ${PROFILE_SELECT} FROM employee_hr_profiles p JOIN employees e ON e.id = p.employee_id WHERE p.employee_id = $1`;
  if (client) {
    const res = await client.query<IHrProfileRow>(sql, [employeeId]);
    return res.rows[0] ?? null;
  }
  return queryOne<IHrProfileRow>(sql, [employeeId]);
};

/** Плоские значения полей профиля (расшифрованные) — для сравнения с OCR и истории. */
export const rowToPlainFields = (row: IHrProfileRow): Record<HrProfileFieldKey, string | boolean | null> => ({
  gender: row.gender,
  citizenship_id: row.citizenship_id,
  has_residence_permit: row.has_residence_permit,
  birth_date: row.birth_date,
  birth_country_id: row.birth_country_id,
  birth_region: row.birth_region,
  birth_city: row.birth_city,
  registration_address: row.registration_address,
  email: row.email,
  phone: row.phone,
  snils: row.pension_number,
  inn: decryptFieldSafe(row.inn_enc),
  passport_type: row.passport_type,
  passport_number: decryptFieldSafe(row.passport_number_enc),
  passport_date: row.passport_date,
  passport_issuer: row.passport_issuer,
  passport_department_code: row.passport_department_code,
  passport_expiry_date: row.passport_expiry_date,
  bank_account_number: decryptFieldSafe(row.bank_account_number_enc),
  bank_bik: row.bank_bik,
  insurance_policy_number: row.insurance_policy_number,
  insurance_policy_date: row.insurance_policy_date,
  kig: decryptFieldSafe(row.kig_enc),
  kig_end_date: row.kig_end_date,
  patent_number: decryptFieldSafe(row.patent_number_enc),
  patent_issue_date: row.patent_issue_date,
  patent_expiry_date: row.patent_expiry_date,
  patent_blank_number: row.patent_blank_number,
  planned_exit_date: row.planned_exit_date,
  notes: row.notes,
});

export const buildProfileView = async (row: IHrProfileRow, opts: { unmask: boolean }): Promise<IHrProfileView> => {
  const citizenship = await getCitizenshipById(row.citizenship_id);
  const birthCountry = await getCitizenshipById(row.birth_country_id);
  const fields = rowToPlainFields(row);
  if (!opts.unmask) {
    for (const key of SENSITIVE_KEYS) {
      const v = fields[key];
      fields[key] = typeof v === 'string' ? maskValue(v) : v;
    }
  }
  const profile = resolveDocumentProfile(citizenship, row.has_residence_permit);
  return {
    employee_id: row.employee_id,
    full_name: row.full_name,
    last_name: row.last_name,
    first_name: row.first_name,
    middle_name: row.middle_name,
    employment_status: row.employment_status,
    hire_date: row.hire_date,
    org_department_id: row.org_department_id,
    tab_number: row.tab_number,
    citizenship: citizenship
      ? { id: citizenship.id, name: citizenship.name, iso_code: citizenship.iso_code, requires_patent: citizenship.requires_patent, is_eaeu: citizenship.is_eaeu }
      : null,
    birth_country: birthCountry ? { id: birthCountry.id, name: birthCountry.name } : null,
    requires_patent: requiresPatent(citizenship, row.has_residence_permit),
    document_profile: profile,
    document_slots: resolveDocumentSlots(profile, row.has_residence_permit),
    masked: !opts.unmask,
    fields,
    zup: {
      is_uploaded: row.zup_is_uploaded,
      uploaded_at: row.zup_uploaded_at,
      marked_by: row.zup_marked_by,
      exported_at: row.zup_exported_at,
    },
    passdesk_id: row.passdesk_id,
    match_rule: row.match_rule,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

// ─── История ────────────────────────────────────────────────────────────────

export type HrHistoryEvent =
  | 'created' | 'profile_update' | 'file_upload' | 'file_delete' | 'ocr_run' | 'ocr_apply' | 'ocr_dismiss'
  | 'zup_toggle' | 'zup_export' | 'attach_existing';
export type HrChangeSource = 'admin' | 'ocr' | 'import' | 'migration' | 'wizard';

export interface IHrActor {
  userId: string | null;
  userName?: string | null;
}

export const resolveActorName = async (userId: string | null | undefined, client?: PoolClient): Promise<string | null> => {
  if (!userId) return null;
  const sql = `SELECT full_name FROM user_profiles WHERE id = $1`;
  const row = client
    ? (await client.query<{ full_name: string | null }>(sql, [userId])).rows[0]
    : await queryOne<{ full_name: string | null }>(sql, [userId]);
  return row?.full_name ?? null;
};

export const recordHistory = async (
  client: PoolClient | null,
  employeeId: number,
  event: HrHistoryEvent,
  opts: {
    changedFields?: string[];
    oldValues?: Record<string, unknown> | null;
    documentId?: number | null;
    actor: IHrActor;
    source: HrChangeSource;
  },
): Promise<void> => {
  const { enc, keyVersion } = opts.oldValues && Object.keys(opts.oldValues).length > 0
    ? encryptJson(opts.oldValues)
    : { enc: null, keyVersion: null };
  const actorName = opts.actor.userName ?? await resolveActorName(opts.actor.userId, client ?? undefined);
  const sql = `INSERT INTO employee_hr_profile_history
      (employee_id, event_type, changed_fields, old_values_enc, key_version, document_id, changed_by, changed_by_name, changed_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
  const params = [employeeId, event, opts.changedFields ?? null, enc, keyVersion, opts.documentId ?? null, opts.actor.userId, actorName, opts.source];
  if (client) await client.query(sql, params);
  else await query(sql, params);
};

export interface IHrHistoryItem {
  id: number;
  event_type: HrHistoryEvent;
  changed_fields: string[] | null;
  /** Старые значения; чувствительные — маскированы, если !unmask. */
  old_values: Record<string, unknown> | null;
  document_id: number | null;
  document_name: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_source: HrChangeSource;
  changed_at: string;
}

export const listHistory = async (employeeId: number, opts: { unmask: boolean; limit?: number }): Promise<IHrHistoryItem[]> => {
  const rows = await query<IHrHistoryItem & { old_values_enc: string | null }>(
    `SELECT h.id, h.event_type, h.changed_fields, h.old_values_enc, h.document_id, d.file_name AS document_name,
            h.changed_by, h.changed_by_name, h.changed_source, h.changed_at
       FROM employee_hr_profile_history h
       LEFT JOIN documents d ON d.id = h.document_id
      WHERE h.employee_id = $1
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT $2`,
    [employeeId, opts.limit ?? 200],
  );
  const sensitive = new Set<string>(SENSITIVE_KEYS);
  return rows.map(({ old_values_enc, ...rest }) => {
    const oldValues = decryptJson<Record<string, unknown>>(old_values_enc);
    if (oldValues && !opts.unmask) {
      for (const key of Object.keys(oldValues)) {
        if (sensitive.has(key) && typeof oldValues[key] === 'string') oldValues[key] = maskValue(oldValues[key] as string);
      }
    }
    return { ...rest, old_values: oldValues };
  });
};

// ─── Антидубль ──────────────────────────────────────────────────────────────

export type DuplicateRule = 'snils' | 'inn' | 'passport_birth' | 'name_birth';

export interface IDuplicateCandidate {
  employee_id: number;
  full_name: string;
  birth_date: string | null;
  employment_status: string;
  department: string | null;
  has_profile: boolean;
  rule: DuplicateRule;
}

export interface IDuplicateLookup {
  snils?: string | null;
  inn?: string | null;
  passport_number?: string | null;
  full_name?: string | null;
  birth_date?: string | null;
}

/**
 * Приоритет: СНИЛС → ИНН → паспорт+дата рождения → ФИО+дата рождения (только
 * единственный кандидат). Только ФИО дублем не считается.
 */
export const findDuplicates = async (lookup: IDuplicateLookup, excludeEmployeeId?: number | null): Promise<IDuplicateCandidate[]> => {
  const out: IDuplicateCandidate[] = [];
  const seen = new Set<number>();
  const push = (rows: Array<Omit<IDuplicateCandidate, 'rule'>>, rule: DuplicateRule): void => {
    for (const r of rows) {
      if (excludeEmployeeId && r.employee_id === excludeEmployeeId) continue;
      if (seen.has(r.employee_id)) continue;
      seen.add(r.employee_id);
      out.push({ ...r, rule });
    }
  };
  const base = `SELECT e.id AS employee_id, e.full_name, e.birth_date, e.employment_status, d.name AS department,
                       (p.employee_id IS NOT NULL) AS has_profile
                  FROM employees e
                  LEFT JOIN org_departments d ON d.id = e.org_department_id
                  LEFT JOIN employee_hr_profiles p ON p.employee_id = e.id`;

  const snilsDigits = normalizeDigits(lookup.snils, 11);
  if (snilsDigits && snilsDigits.length === 11) {
    const snilsHash = hashForSearch('snils', snilsDigits);
    push(await query(`${base} WHERE regexp_replace(COALESCE(e.pension_number, ''), '\\D', '', 'g') = $1 OR p.snils_hash = $2 LIMIT 10`, [snilsDigits, snilsHash]), 'snils');
  }
  const innHash = hashForSearch('inn', lookup.inn);
  if (innHash) push(await query(`${base} WHERE p.inn_hash = $1 LIMIT 10`, [innHash]), 'inn');

  const passportHash = hashForSearch('passport', lookup.passport_number);
  if (passportHash && lookup.birth_date) {
    push(await query(`${base} WHERE p.passport_number_hash = $1 AND e.birth_date = $2::date LIMIT 10`, [passportHash, lookup.birth_date]), 'passport_birth');
  }
  const nameKey = normalizeNameForHash(lookup.full_name);
  if (nameKey && lookup.birth_date) {
    const rows = await query<Omit<IDuplicateCandidate, 'rule'>>(
      `${base} WHERE lower(regexp_replace(translate(e.full_name, 'Ёё', 'Ее'), '\\s+', ' ', 'g')) = $1 AND e.birth_date = $2::date LIMIT 10`,
      [nameKey, lookup.birth_date],
    );
    if (rows.length === 1) push(rows, 'name_birth');
  }
  return out;
};

// ─── Запись ─────────────────────────────────────────────────────────────────

const normalizeInput = (input: IHrProfileInput): IHrProfileInput => {
  const out: IHrProfileInput = { ...input };
  const trim = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s || null;
  };
  for (const key of Object.keys(out) as HrProfileFieldKey[]) {
    if (key === 'has_residence_permit') continue;
    (out as Record<string, unknown>)[key] = trim(out[key]);
  }
  if (out.snils !== undefined) out.snils = normalizeDigits(out.snils, 11);
  if (out.inn !== undefined) out.inn = normalizeDigits(out.inn, 12);
  if (out.bank_account_number !== undefined) out.bank_account_number = normalizeDigits(out.bank_account_number, 20);
  if (out.bank_bik !== undefined) out.bank_bik = normalizeDigits(out.bank_bik, 9);
  if (out.kig !== undefined) out.kig = normalizeDocNumber(out.kig);
  if (out.passport_department_code !== undefined && out.passport_department_code) {
    const d = out.passport_department_code.replace(/\D/g, '');
    out.passport_department_code = d.length === 6 ? `${d.slice(0, 3)}-${d.slice(3)}` : out.passport_department_code.slice(0, 7);
  }
  return out;
};

export interface IProfileWriteResult {
  changedFields: string[];
  zupReset: boolean;
}

const valuesEqual = (a: unknown, b: unknown): boolean => {
  const na = a === undefined || a === null ? '' : String(a);
  const nb = b === undefined || b === null ? '' : String(b);
  return na === nb;
};

/**
 * Применяет патч к профилю и employees в одной транзакции. Профиль должен
 * существовать (createProfile создаёт пустой). Возвращает список изменённых полей.
 */
export const applyProfilePatch = async (
  client: PoolClient,
  employeeId: number,
  rawInput: IHrProfileInput,
  actor: IHrActor,
  source: HrChangeSource,
  opts?: { skipHistory?: boolean; historyEvent?: HrHistoryEvent; documentId?: number | null },
): Promise<IProfileWriteResult> => {
  const input = normalizeInput(rawInput);
  const current = await loadProfileRow(employeeId, client);
  if (!current) throw new Error('HR-профиль не найден');
  const currentPlain = rowToPlainFields(current);

  const changed: string[] = [];
  const oldValues: Record<string, unknown> = {};
  const profileSets: string[] = [];
  const profileParams: unknown[] = [];
  const employeeSets: string[] = [];
  const employeeParams: unknown[] = [];
  const addProfile = (col: string, value: unknown): void => {
    profileParams.push(value);
    profileSets.push(`${col} = $${profileParams.length}`);
  };
  const addEmployee = (col: string, value: unknown): void => {
    employeeParams.push(value);
    employeeSets.push(`${col} = $${employeeParams.length}`);
  };

  let citizenshipChanged = false;
  for (const key of Object.keys(input) as HrProfileFieldKey[]) {
    if (!HR_INPUT_KEYS.includes(key)) continue;
    const next = input[key];
    const prev = currentPlain[key];
    if (valuesEqual(prev, next)) continue;
    changed.push(key);
    oldValues[key] = prev ?? null;

    if (EMPLOYEE_OWNED[key]) {
      addEmployee(EMPLOYEE_OWNED[key], next ?? null);
      if (key === 'snils') addProfile('snils_hash', hashForSearch('snils', next as string | null));
      continue;
    }
    const enc = ENC_COLUMNS[key];
    if (enc) {
      const { enc: ct, keyVersion } = encryptField(next as string | null);
      addProfile(enc.enc, ct);
      addProfile(enc.ver, keyVersion);
      if (enc.hash && enc.hashField) addProfile(enc.hash, hashForSearch(enc.hashField, next as string | null));
      continue;
    }
    if (key === 'citizenship_id') citizenshipChanged = true;
    if (PLAIN_PROFILE_COLUMNS.includes(key)) addProfile(key, next ?? null);
  }

  if (changed.length === 0) return { changedFields: [], zupReset: false };

  let zupReset = false;
  if (current.zup_is_uploaded && changed.some(f => ZUP_RELEVANT_FIELDS.includes(f))) {
    addProfile('zup_is_uploaded', false);
    zupReset = true;
  }
  if (citizenshipChanged) {
    const cit = await getCitizenshipById(input.citizenship_id ?? null);
    addEmployee('country', cit ? cit.name.toUpperCase() : null);
  }
  addProfile('updated_by', actor.userId);
  profileParams.push(employeeId);
  await client.query(
    `UPDATE employee_hr_profiles SET ${profileSets.join(', ')}, updated_at = now() WHERE employee_id = $${profileParams.length}`,
    profileParams,
  );
  if (employeeSets.length > 0) {
    employeeParams.push(employeeId);
    await client.query(`UPDATE employees SET ${employeeSets.join(', ')}, updated_at = now() WHERE id = $${employeeParams.length}`, employeeParams);
  }
  await upsertIdentityClaims(client, employeeId, {
    snils: input.snils !== undefined ? input.snils : (currentPlain.snils as string | null),
    inn: input.inn !== undefined ? input.inn : (currentPlain.inn as string | null),
    passport_number: input.passport_number !== undefined ? input.passport_number : (currentPlain.passport_number as string | null),
  });
  if (!opts?.skipHistory) {
    await recordHistory(client, employeeId, opts?.historyEvent ?? 'profile_update', {
      changedFields: changed,
      oldValues,
      documentId: opts?.documentId ?? null,
      actor,
      source,
    });
  }
  return { changedFields: changed, zupReset };
};

/** Резерв идентификаторов за сотрудником (антидубль). Чужой claim → 409 наружу. */
export class IdentityClaimConflictError extends Error {
  constructor(readonly claimType: 'snils' | 'inn' | 'passport', readonly employeeId: number | null, readonly draftId: string | null) {
    super('Идентификатор уже закреплён за другим сотрудником');
    this.name = 'IdentityClaimConflictError';
  }
}

export const upsertIdentityClaims = async (
  client: PoolClient,
  employeeId: number,
  values: { snils?: string | null; inn?: string | null; passport_number?: string | null },
): Promise<void> => {
  const claims: Array<{ type: 'snils' | 'inn' | 'passport'; hash: string | null }> = [
    { type: 'snils', hash: hashForSearch('snils', values.snils) },
    { type: 'inn', hash: hashForSearch('inn', values.inn) },
    { type: 'passport', hash: hashForSearch('passport', values.passport_number) },
  ];
  for (const claim of claims) {
    if (!claim.hash) {
      await client.query(`DELETE FROM hr_identity_claims WHERE claim_type = $1 AND employee_id = $2`, [claim.type, employeeId]);
      continue;
    }
    const existing = await client.query<{ employee_id: number | null; draft_id: string | null }>(
      `SELECT employee_id, draft_id FROM hr_identity_claims WHERE claim_type = $1 AND claim_hash = $2`,
      [claim.type, claim.hash],
    );
    const row = existing.rows[0];
    if (row && row.employee_id !== employeeId) {
      throw new IdentityClaimConflictError(claim.type, row.employee_id, row.draft_id);
    }
    await client.query(`DELETE FROM hr_identity_claims WHERE claim_type = $1 AND employee_id = $2 AND claim_hash <> $3`, [claim.type, employeeId, claim.hash]);
    await client.query(
      `INSERT INTO hr_identity_claims (claim_type, claim_hash, employee_id) VALUES ($1, $2, $3)
       ON CONFLICT (claim_type, claim_hash) DO UPDATE SET employee_id = EXCLUDED.employee_id, draft_id = NULL`,
      [claim.type, claim.hash, employeeId],
    );
  }
};

/** Создать пустой профиль (idempotent) + сразу применить input, если есть. */
export const createProfile = async (
  employeeId: number,
  input: IHrProfileInput,
  actor: IHrActor,
  source: HrChangeSource,
  extra?: { passdeskId?: string | null; passdeskIdAll?: string | null; matchRule?: string | null; client?: PoolClient },
): Promise<IProfileWriteResult> => {
  const run = async (client: PoolClient): Promise<IProfileWriteResult> => {
    const existing = await client.query<{ employee_id: number }>(`SELECT employee_id FROM employee_hr_profiles WHERE employee_id = $1`, [employeeId]);
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO employee_hr_profiles (employee_id, created_by, updated_by, passdesk_id, passdesk_id_all, match_rule, snils_hash)
         SELECT $1, $2, $2, $3, $4, $5, $6
         ON CONFLICT (employee_id) DO NOTHING`,
        [employeeId, actor.userId, extra?.passdeskId ?? null, extra?.passdeskIdAll ?? null, extra?.matchRule ?? null,
          hashForSearch('snils', (await client.query<{ pension_number: string | null }>(`SELECT pension_number FROM employees WHERE id = $1`, [employeeId])).rows[0]?.pension_number ?? null)],
      );
      await recordHistory(client, employeeId, 'created', { actor, source });
    }
    return applyProfilePatch(client, employeeId, input, actor, source);
  };
  return extra?.client ? run(extra.client) : withTransaction(run);
};

export const updateProfile = async (
  employeeId: number,
  input: IHrProfileInput,
  actor: IHrActor,
  source: HrChangeSource = 'admin',
): Promise<IProfileWriteResult> => withTransaction(client => applyProfilePatch(client, employeeId, input, actor, source));

// ─── ЗУП ────────────────────────────────────────────────────────────────────

export const setZupUploaded = async (employeeId: number, isUploaded: boolean, actor: IHrActor): Promise<void> => {
  await withTransaction(async client => {
    const res = await client.query(
      `UPDATE employee_hr_profiles
          SET zup_is_uploaded = $2,
              zup_uploaded_at = CASE WHEN $2 THEN now() ELSE zup_uploaded_at END,
              zup_marked_by = $3, updated_by = $3, updated_at = now()
        WHERE employee_id = $1 AND zup_is_uploaded IS DISTINCT FROM $2`,
      [employeeId, isUploaded, actor.userId],
    );
    if ((res.rowCount ?? 0) > 0) {
      await recordHistory(client, employeeId, 'zup_toggle', {
        changedFields: ['zup_is_uploaded'],
        oldValues: { zup_is_uploaded: !isUploaded },
        actor,
        source: 'admin',
      });
    }
  });
};

export const markZupExported = async (employeeIds: number[], actor: IHrActor): Promise<void> => {
  if (employeeIds.length === 0) return;
  await withTransaction(async client => {
    await client.query(
      `UPDATE employee_hr_profiles SET zup_exported_at = now(), zup_exported_by = $2 WHERE employee_id = ANY($1::int[])`,
      [employeeIds, actor.userId],
    );
    const actorName = await resolveActorName(actor.userId, client);
    await client.query(
      `INSERT INTO employee_hr_profile_history (employee_id, event_type, changed_by, changed_by_name, changed_source)
       SELECT unnest($1::int[]), 'zup_export', $2, $3, 'admin'`,
      [employeeIds, actor.userId, actorName],
    );
  });
};

export const getActiveKeyVersionSafe = (): string | null => {
  try {
    return getActiveHrKeyVersion();
  } catch {
    return null;
  }
};
