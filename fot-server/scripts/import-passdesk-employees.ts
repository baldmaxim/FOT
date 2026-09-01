/**
 * Перенос раздела «Сотрудники» PassDesk → кадровые профили FOT («Реквизиты»).
 *
 *   npx tsx scripts/import-passdesk-employees.ts --preview [--out temp/passdesk-preview.xlsx]
 *   npx tsx scripts/import-passdesk-employees.ts --apply [--files] [--mapping temp/mapping.xlsx] [--since 2026-08-01T00:00:00Z]
 *
 * Env (только в процессе скрипта, в .env FOT не хранить):
 *   PASSDESK_DATABASE_URL            read-only подключение к БД PassDesk
 *   PASSDESK_FIELD_ENCRYPTION_KEYS   JSON {"v1":"<base64>"} (ключи полей PassDesk)
 *   PASSDESK_FILE_ENCRYPTION_KEYS    JSON (по умолчанию = FIELD keys)
 *   PASSDESK_S3_ENDPOINT / _REGION / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _BUCKET / _BASE_PATH
 *   HR_MIGRATION_USER_ID             существующий user_profiles.id администратора миграции
 * Плюс штатный .env FOT (DATABASE_URL, HR_FIELD_ENCRYPTION_KEYS, …, R2).
 *
 * Правила сопоставления (приоритет): external_ref (уже перенесён) → mapping-файл (manual) →
 * СНИЛС → ИНН (по хэшу профиля) → паспорт+дата рождения (по хэшу) → ФИО+дата рождения при
 * единственном кандидате → staging «candidate» (ручное подтверждение); неоднозначные →
 * «ambiguous»; только ФИО → «unmatched». Автоперенос — только для первых четырёх правил.
 *
 * Идемпотентность: hr_external_refs (passdesk, employee_profile|document, source_id).
 * Повторный --apply не создаёт ни строк, ни копий файлов; sha256 каждого файла сверяется
 * после загрузки в R2 обратным скачиванием.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { query, queryOne, execute, withTransaction, closeDb } from '../src/config/postgres.js';
import { encryptJson, hashForSearch, isHrCryptoConfigured, normalizeDigits, normalizeNameForHash, sha256Hex } from '../src/services/hr-crypto.service.js';
import { createProfile, findCitizenshipByValue, type IHrProfileInput } from '../src/services/hr-profile.service.js';
import { loadDecryptedBytes, loadHrDocument, uploadHrDocument } from '../src/services/hr-documents.service.js';
import { getHrDocumentType } from '../src/config/hr-documents.js';
import { decryptPassdeskField, decryptPassdeskFile, isPassdeskCryptoConfigured } from './lib/passdesk-crypto.js';

type MatchRule = 'external_ref' | 'manual' | 'snils' | 'inn' | 'passport_birth' | 'name_birth' | 'ambiguous' | 'unmatched';
const AUTO_RULES = new Set<MatchRule>(['external_ref', 'manual', 'snils', 'inn', 'passport_birth']);

interface IPdEmployee {
  id: string;
  id_all: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name_enc: string | null;
  last_name_key_version: string | null;
  gender: 'male' | 'female' | null;
  citizenship_name: string | null;
  birth_country_name: string | null;
  birth_region: string | null;
  birth_city: string | null;
  birth_date: string | null;
  inn: string | null;
  snils: string | null;
  passport_number_enc: string | null;
  passport_number_key_version: string | null;
  passport_date: string | null;
  passport_issuer: string | null;
  passport_department_code: string | null;
  passport_type: 'russian' | 'foreign' | null;
  passport_expiry_date: string | null;
  kig_enc: string | null;
  kig_key_version: string | null;
  kig_end_date: string | null;
  registration_address: string | null;
  patent_number_enc: string | null;
  patent_number_key_version: string | null;
  patent_issue_date: string | null;
  blank_number: string | null;
  email: string | null;
  phone: string | null;
  insurance_policy_number: string | null;
  insurance_policy_date: string | null;
  planned_exit_date: string | null;
  bank_account_number: string | null;
  bank_bik: string | null;
  notes: string | null;
  is_active: boolean;
  has_residence_permit: boolean | null;
  counterparty: string | null;
  updated_at: string;
  zup_uploaded: boolean;
  zup_uploaded_at: string | null;
  last_change_at: string;
}

interface IPdFile {
  id: string;
  employee_id: string;
  file_path: string;
  original_name: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  document_type: string | null;
  is_encrypted: boolean;
  encryption_algorithm: string | null;
  encryption_iv: string | null;
  encryption_tag: string | null;
  encryption_key_version: string | null;
  created_at: string;
}

interface IMatch {
  rule: MatchRule;
  employeeId: number | null;
  candidates: number[];
}

const args = new Set(process.argv.slice(2).filter(a => a.startsWith('--') && !a.includes('=')));
const argValue = (name: string): string | null => {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
};
const MODE_PREVIEW = args.has('--preview');
const MODE_APPLY = args.has('--apply');
const WITH_FILES = args.has('--files');
const OUT = argValue('--out') ?? `temp/passdesk-preview-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;
const MAPPING = argValue('--mapping');
const SINCE = argValue('--since');

const log = (...a: unknown[]): void => console.log('[passdesk-import]', ...a);

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Не задан ${name}`);
  return v;
};

// ─── PassDesk ───────────────────────────────────────────────────────────────

const pdPool = new Pool({ connectionString: requireEnv('PASSDESK_DATABASE_URL'), max: 3, ssl: process.env.PASSDESK_DATABASE_SSL === 'false' ? undefined : { rejectUnauthorized: false } });

const loadPassdeskEmployees = async (): Promise<IPdEmployee[]> => {
  const res = await pdPool.query<IPdEmployee>(`
    SELECT e.id, e.id_all, e.first_name, e.middle_name, e.last_name_enc, e.last_name_key_version, e.gender,
           c.name AS citizenship_name, bc.name AS birth_country_name, e.birth_region, e.birth_city, e.birth_date,
           e.inn, e.snils, e.passport_number_enc, e.passport_number_key_version, e.passport_date, e.passport_issuer,
           e.passport_department_code, e.passport_type, e.passport_expiry_date, e.kig_enc, e.kig_key_version, e.kig_end_date,
           e.registration_address, e.patent_number_enc, e.patent_number_key_version, e.patent_issue_date, e.blank_number,
           e.email, e.phone, e.insurance_policy_number, e.insurance_policy_date, e.planned_exit_date,
           e.bank_account_number, e.bank_bik, e.notes, e.is_active, e.has_residence_permit,
           (SELECT cp.name FROM employee_counterparty_mapping m JOIN counterparties cp ON cp.id = m.counterparty_id
             WHERE m.employee_id = e.id ORDER BY (m.dismissed_at IS NULL) DESC, m.updated_at DESC LIMIT 1) AS counterparty,
           e.updated_at,
           COALESCE((SELECT bool_and(s.is_upload) FROM employees_statuses_mapping s WHERE s.employee_id = e.id AND s.is_active = true), false) AS zup_uploaded,
           (SELECT a.created_at FROM audit_logs a WHERE a.action = 'zup_flag_changed' AND a.entity_type = 'employee' AND a.entity_id = e.id::text
              AND lower(a.details->>'to') = 'true' ORDER BY a.created_at DESC LIMIT 1) AS zup_uploaded_at,
           GREATEST(e.updated_at,
             COALESCE((SELECT max(f.updated_at) FROM files f WHERE f.employee_id = e.id), e.updated_at),
             COALESCE((SELECT max(s.updated_at) FROM employees_statuses_mapping s WHERE s.employee_id = e.id), e.updated_at),
             COALESCE((SELECT max(a.created_at) FROM audit_logs a WHERE a.action = 'zup_flag_changed' AND a.entity_type = 'employee' AND a.entity_id = e.id::text), e.updated_at)
           ) AS last_change_at
      FROM employees e
      LEFT JOIN citizenships c ON c.id = e.citizenship_id
      LEFT JOIN citizenships bc ON bc.id = e.birth_country_id
     WHERE e.is_deleted = false
     ORDER BY e.updated_at`);
  return res.rows;
};

const loadPassdeskFiles = async (employeeIds: string[]): Promise<Map<string, IPdFile[]>> => {
  const map = new Map<string, IPdFile[]>();
  if (employeeIds.length === 0) return map;
  const res = await pdPool.query<IPdFile>(`
    SELECT id, employee_id, file_path, original_name, file_name, mime_type, file_size, document_type::text AS document_type,
           is_encrypted, encryption_algorithm, encryption_iv, encryption_tag, encryption_key_version, created_at
      FROM files
     WHERE entity_type = 'employee' AND is_deleted = false AND employee_id = ANY($1::uuid[])
     ORDER BY created_at`, [employeeIds]);
  for (const f of res.rows) map.set(f.employee_id, [...(map.get(f.employee_id) ?? []), f]);
  return map;
};

let s3: S3Client | null = null;
const s3Client = (): S3Client => {
  if (s3) return s3;
  s3 = new S3Client({
    endpoint: requireEnv('PASSDESK_S3_ENDPOINT'),
    region: process.env.PASSDESK_S3_REGION || 'ru-1',
    forcePathStyle: true,
    credentials: { accessKeyId: requireEnv('PASSDESK_S3_ACCESS_KEY_ID'), secretAccessKey: requireEnv('PASSDESK_S3_SECRET_ACCESS_KEY') },
  });
  return s3;
};

const s3ObjectKey = (filePath: string): string => {
  const base = (process.env.PASSDESK_S3_BASE_PATH || '').replace(/^\/+|\/+$/g, '');
  const rel = filePath.replace(/^\/+/, '');
  if (!base || rel === base || rel.startsWith(`${base}/`)) return rel;
  return `${base}/${rel}`;
};

const downloadPassdeskFile = async (file: IPdFile): Promise<Buffer> => {
  const res = await s3Client().send(new GetObjectCommand({ Bucket: requireEnv('PASSDESK_S3_BUCKET'), Key: s3ObjectKey(file.file_path) }));
  const bytes = Buffer.from(await res.Body!.transformToByteArray());
  return decryptPassdeskFile(bytes, {
    is_encrypted: file.is_encrypted, encryption_algorithm: file.encryption_algorithm, encryption_iv: file.encryption_iv,
    encryption_tag: file.encryption_tag, encryption_key_version: file.encryption_key_version, document_type: file.document_type,
  });
};

// ─── Расшифровка и профиль ──────────────────────────────────────────────────

const fullNameOf = (e: IPdEmployee): string => {
  const last = decryptPassdeskField(e.last_name_enc, e.last_name_key_version) ?? '';
  return [last, e.first_name, e.middle_name].map(s => (s ?? '').trim()).filter(Boolean).join(' ');
};

const buildProfileInput = async (e: IPdEmployee): Promise<IHrProfileInput & { citizenship_name?: string | null }> => {
  const cit = await findCitizenshipByValue(e.citizenship_name);
  const birthCountry = await findCitizenshipByValue(e.birth_country_name);
  return {
    gender: e.gender,
    citizenship_id: cit?.id ?? null,
    citizenship_name: e.citizenship_name,
    has_residence_permit: !!e.has_residence_permit,
    birth_date: e.birth_date,
    birth_country_id: birthCountry?.id ?? null,
    birth_region: e.birth_region,
    birth_city: e.birth_city,
    registration_address: e.registration_address,
    email: e.email,
    phone: e.phone,
    snils: e.snils,
    inn: e.inn,
    passport_type: e.passport_type,
    passport_number: decryptPassdeskField(e.passport_number_enc, e.passport_number_key_version),
    passport_date: e.passport_date,
    passport_issuer: e.passport_issuer,
    passport_department_code: e.passport_department_code,
    passport_expiry_date: e.passport_expiry_date,
    bank_account_number: e.bank_account_number,
    bank_bik: e.bank_bik,
    insurance_policy_number: e.insurance_policy_number,
    insurance_policy_date: e.insurance_policy_date,
    kig: decryptPassdeskField(e.kig_enc, e.kig_key_version),
    kig_end_date: e.kig_end_date,
    patent_number: decryptPassdeskField(e.patent_number_enc, e.patent_number_key_version),
    patent_issue_date: e.patent_issue_date,
    patent_blank_number: e.blank_number,
    planned_exit_date: e.planned_exit_date,
    notes: e.notes,
  };
};

// ─── Сопоставление ──────────────────────────────────────────────────────────

interface IFotEmployeeLite { id: number; full_name: string; birth_date: string | null; pension_number: string | null; email: string | null; patent_issue_date: string | null; patent_expiry_date: string | null; country: string | null }

const readMappingFile = async (): Promise<Map<string, number>> => {
  const map = new Map<string, number>();
  if (!MAPPING) return map;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(MAPPING);
  const ws = wb.worksheets[0];
  const header = (ws.getRow(1).values as unknown[]).map(v => String(v ?? '').trim().toLowerCase());
  const idxPd = header.indexOf('passdesk_id');
  const idxEmp = header.findIndex(h => h === 'employee_id' || h === 'fot_employee_id');
  if (idxPd < 0 || idxEmp < 0) throw new Error('mapping: нужны колонки passdesk_id и employee_id');
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const pd = String(row.getCell(idxPd).value ?? '').trim();
    const emp = Number(row.getCell(idxEmp).value);
    if (pd && Number.isInteger(emp) && emp > 0) map.set(pd, emp);
  });
  return map;
};

const matchEmployee = async (e: IPdEmployee, profile: IHrProfileInput, fullName: string, mapping: Map<string, number>): Promise<IMatch> => {
  const ref = await queryOne<{ entity_id: number }>(`SELECT entity_id FROM hr_external_refs WHERE source_system = 'passdesk' AND entity_type = 'employee_profile' AND source_id = $1`, [e.id]);
  if (ref) return { rule: 'external_ref', employeeId: Number(ref.entity_id), candidates: [] };
  const manual = mapping.get(e.id);
  if (manual) return { rule: 'manual', employeeId: manual, candidates: [] };

  const snils = normalizeDigits(profile.snils, 11);
  if (snils && snils.length === 11) {
    const rows = await query<{ id: number }>(`SELECT id FROM employees WHERE regexp_replace(COALESCE(pension_number,''), '\\D', '', 'g') = $1`, [snils]);
    if (rows.length === 1) return { rule: 'snils', employeeId: rows[0].id, candidates: [] };
    if (rows.length > 1) return { rule: 'ambiguous', employeeId: null, candidates: rows.map(r => r.id) };
  }
  const innHash = hashForSearch('inn', profile.inn);
  if (innHash) {
    const rows = await query<{ employee_id: number }>(`SELECT employee_id FROM employee_hr_profiles WHERE inn_hash = $1`, [innHash]);
    if (rows.length === 1) return { rule: 'inn', employeeId: rows[0].employee_id, candidates: [] };
  }
  const passportHash = hashForSearch('passport', profile.passport_number);
  if (passportHash && e.birth_date) {
    const rows = await query<{ employee_id: number }>(`SELECT p.employee_id FROM employee_hr_profiles p JOIN employees em ON em.id = p.employee_id WHERE p.passport_number_hash = $1 AND em.birth_date = $2::date`, [passportHash, e.birth_date]);
    if (rows.length === 1) return { rule: 'passport_birth', employeeId: rows[0].employee_id, candidates: [] };
  }
  const nameKey = normalizeNameForHash(fullName);
  if (nameKey) {
    const byName = await query<{ id: number; birth_date: string | null }>(
      `SELECT id, birth_date FROM employees WHERE lower(regexp_replace(translate(full_name, 'Ёё', 'Ее'), '\\s+', ' ', 'g')) = $1`, [nameKey]);
    if (e.birth_date) {
      const sameBirth = byName.filter(r => r.birth_date && String(r.birth_date).slice(0, 10) === String(e.birth_date).slice(0, 10));
      if (sameBirth.length === 1) return { rule: 'name_birth', employeeId: sameBirth[0].id, candidates: [sameBirth[0].id] };
      if (sameBirth.length > 1) return { rule: 'ambiguous', employeeId: null, candidates: sameBirth.map(r => r.id) };
    }
    if (byName.length >= 1) return { rule: byName.length === 1 ? 'unmatched' : 'ambiguous', employeeId: null, candidates: byName.map(r => r.id) };
  }
  return { rule: 'unmatched', employeeId: null, candidates: [] };
};

// ─── Apply ──────────────────────────────────────────────────────────────────

const migrationUserId = (): string => requireEnv('HR_MIGRATION_USER_ID');

const applyProfile = async (e: IPdEmployee, profile: IHrProfileInput, match: IMatch): Promise<'created' | 'skipped'> => {
  const employeeId = match.employeeId!;
  const existingRef = match.rule === 'external_ref';
  if (existingRef) return 'skipped';
  const fot = await queryOne<IFotEmployeeLite>(`SELECT id, full_name, birth_date, pension_number, email, patent_issue_date, patent_expiry_date, country FROM employees WHERE id = $1`, [employeeId]);
  if (!fot) throw new Error(`Сотрудник FOT #${employeeId} не найден`);
  // Поля, принадлежащие employees, дозаполняем только если в FOT пусто.
  const input: IHrProfileInput = { ...profile };
  delete (input as Record<string, unknown>).citizenship_name;
  if (fot.birth_date) delete input.birth_date;
  if (fot.pension_number) delete input.snils;
  if (fot.email) delete input.email;
  if (fot.patent_issue_date) delete input.patent_issue_date;
  if (fot.patent_expiry_date) delete input.patent_expiry_date;

  await withTransaction(async client => {
    await createProfile(employeeId, input, { userId: migrationUserId(), userName: 'Перенос из PassDesk' }, 'migration', {
      passdeskId: e.id, passdeskIdAll: e.id_all, matchRule: match.rule, client,
    });
    await client.query(
      `UPDATE employee_hr_profiles SET zup_is_uploaded = $2, zup_uploaded_at = $3 WHERE employee_id = $1 AND zup_uploaded_at IS NULL`,
      [employeeId, e.zup_uploaded, e.zup_uploaded_at],
    );
    await client.query(
      `INSERT INTO hr_external_refs (source_system, entity_type, source_id, entity_id) VALUES ('passdesk', 'employee_profile', $1, $2)
       ON CONFLICT (source_system, entity_type, source_id) DO NOTHING`,
      [e.id, employeeId],
    );
  });
  return 'created';
};

const upsertStaging = async (e: IPdEmployee, profile: IHrProfileInput & { citizenship_name?: string | null }, fullName: string, match: IMatch, files: IPdFile[]): Promise<void> => {
  const state = match.rule === 'name_birth' ? 'candidate' : match.rule === 'ambiguous' ? 'ambiguous' : 'unmatched';
  const { enc, keyVersion } = encryptJson({ profile, passdesk_id_all: e.id_all, employee: { full_name: fullName, counterparty: e.counterparty, is_active: e.is_active } });
  const fileList = files.map(f => ({ source_id: f.id, document_type: f.document_type, file_name: f.original_name ?? f.file_name, size: f.file_size }));
  await execute(
    `INSERT INTO hr_profile_import_staging (passdesk_id, full_name, birth_date, citizenship, counterparty, is_active, match_state, candidate_employee_ids, payload_enc, key_version, files)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (passdesk_id) DO UPDATE SET full_name = EXCLUDED.full_name, birth_date = EXCLUDED.birth_date, citizenship = EXCLUDED.citizenship,
       counterparty = EXCLUDED.counterparty, is_active = EXCLUDED.is_active, payload_enc = EXCLUDED.payload_enc, key_version = EXCLUDED.key_version, files = EXCLUDED.files,
       match_state = CASE WHEN hr_profile_import_staging.match_state IN ('linked','created') THEN hr_profile_import_staging.match_state ELSE EXCLUDED.match_state END,
       candidate_employee_ids = EXCLUDED.candidate_employee_ids`,
    [e.id, fullName, e.birth_date, e.citizenship_name, e.counterparty, e.is_active, state, match.candidates.length ? match.candidates : null, enc, keyVersion, JSON.stringify(fileList)],
  );
};

const transferFiles = async (employeeId: number, files: IPdFile[], stats: { filesCopied: number; filesSkipped: number; filesFailed: number }): Promise<void> => {
  for (const f of files) {
    const ref = await queryOne<{ entity_id: number }>(`SELECT entity_id FROM hr_external_refs WHERE source_system = 'passdesk' AND entity_type = 'document' AND source_id = $1`, [f.id]);
    if (ref) { stats.filesSkipped += 1; continue; }
    const type = f.document_type ? getHrDocumentType(f.document_type) : null;
    const typeCode = type?.code ?? 'other';
    try {
      const plain = await downloadPassdeskFile(f);
      const sha = sha256Hex(plain);
      const row = await uploadHrDocument({ employeeId }, {
        buffer: plain,
        mimeType: f.mime_type ?? 'application/octet-stream',
        originalName: f.original_name ?? f.file_name ?? `${f.id}.bin`,
        typeCode,
        uploadedBy: migrationUserId(),
        actorName: 'Перенос из PassDesk',
        skipOcr: true,
        historySource: 'migration',
        createdAt: f.created_at,
      });
      // Обратная проверка: скачать из R2, расшифровать, сверить sha256.
      const stored = await loadHrDocument(row.id);
      const back = stored ? await loadDecryptedBytes(stored) : null;
      if (!back || sha256Hex(back) !== sha) throw new Error('sha256 после загрузки не совпал');
      await execute(
        `INSERT INTO hr_external_refs (source_system, entity_type, source_id, entity_id, sha256) VALUES ('passdesk', 'document', $1, $2, $3)
         ON CONFLICT (source_system, entity_type, source_id) DO NOTHING`,
        [f.id, row.id, sha],
      );
      stats.filesCopied += 1;
    } catch (err) {
      stats.filesFailed += 1;
      log(`  файл ${f.id} (${typeCode}) не перенесён: ${err instanceof Error ? err.message : err}`);
    }
  }
};

// ─── Main ───────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!MODE_PREVIEW && !MODE_APPLY) throw new Error('Укажите --preview или --apply');
  if (!isHrCryptoConfigured()) throw new Error('HR_FIELD_ENCRYPTION_KEYS / ACTIVE_KEY_VERSION / HASH_PEPPER не заданы (FOT)');
  if (!isPassdeskCryptoConfigured()) throw new Error('PASSDESK_FIELD_ENCRYPTION_KEYS не задан');
  if (MODE_APPLY) migrationUserId();

  const mapping = await readMappingFile();
  const all = await loadPassdeskEmployees();
  const employees = SINCE ? all.filter(e => new Date(e.last_change_at) > new Date(SINCE)) : all;
  log(`PassDesk: сотрудников ${all.length}${SINCE ? `, изменённых после ${SINCE}: ${employees.length}` : ''}`);
  const filesByEmployee = await loadPassdeskFiles(employees.map(e => e.id));

  const report: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = {};
  const stats = { profilesCreated: 0, profilesSkipped: 0, staged: 0, filesCopied: 0, filesSkipped: 0, filesFailed: 0 };

  for (const e of employees) {
    const fullName = fullNameOf(e);
    const profile = await buildProfileInput(e);
    const match = await matchEmployee(e, profile, fullName, mapping);
    const files = filesByEmployee.get(e.id) ?? [];
    counts[match.rule] = (counts[match.rule] ?? 0) + 1;
    const fileBytes = files.reduce((s, f) => s + Number(f.file_size ?? 0), 0);
    report.push({
      passdesk_id: e.id, full_name: fullName, birth_date: e.birth_date, citizenship: e.citizenship_name, counterparty: e.counterparty,
      is_active: e.is_active, rule: match.rule, employee_id: match.employeeId, candidates: match.candidates.join(','),
      files: files.length, files_bytes: fileBytes, zup: e.zup_uploaded, zup_at: e.zup_uploaded_at, last_change_at: e.last_change_at,
    });

    if (!MODE_APPLY) continue;
    if (AUTO_RULES.has(match.rule) && match.employeeId) {
      const r = await applyProfile(e, profile, match);
      if (r === 'created') stats.profilesCreated += 1; else stats.profilesSkipped += 1;
      if (WITH_FILES) await transferFiles(match.employeeId, files, stats);
    } else {
      await upsertStaging(e, profile, fullName, match, files);
      stats.staged += 1;
    }
  }

  // Staging-записи, привязанные администратором вручную: докачать их файлы.
  if (MODE_APPLY && WITH_FILES) {
    const linked = await query<{ passdesk_id: string; linked_employee_id: number }>(
      `SELECT passdesk_id, linked_employee_id FROM hr_profile_import_staging WHERE linked_employee_id IS NOT NULL`);
    const linkedFiles = await loadPassdeskFiles(linked.map(l => l.passdesk_id));
    for (const l of linked) {
      await transferFiles(l.linked_employee_id, linkedFiles.get(l.passdesk_id) ?? [], stats);
    }
  }

  // Отчёт (всегда — и для preview, и для apply).
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Сопоставление');
  const columns = ['passdesk_id', 'full_name', 'birth_date', 'citizenship', 'counterparty', 'is_active', 'rule', 'employee_id', 'candidates', 'files', 'files_bytes', 'zup', 'zup_at', 'last_change_at'];
  ws.addRow(columns).font = { bold: true };
  for (const r of report) ws.addRow(columns.map(c => r[c] ?? ''));
  ws.columns.forEach(c => { c.width = 20; });
  const ws2 = wb.addWorksheet('Файлы');
  ws2.addRow(['passdesk_id', 'file_id', 'document_type', 'file_name', 'size', 'created_at']).font = { bold: true };
  for (const e of employees) for (const f of filesByEmployee.get(e.id) ?? []) ws2.addRow([e.id, f.id, f.document_type, f.original_name ?? f.file_name, f.file_size, f.created_at]);
  const ws3 = wb.addWorksheet('Итоги');
  for (const [k, v] of Object.entries(counts)) ws3.addRow([k, v]);
  ws3.addRow(['files_total', report.reduce((s, r) => s + Number(r.files), 0)]);
  ws3.addRow(['files_bytes_total', report.reduce((s, r) => s + Number(r.files_bytes), 0)]);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await wb.xlsx.writeFile(OUT);

  log('Правила сопоставления:', counts);
  log(`Отчёт: ${OUT}`);
  if (MODE_APPLY) log('Применено:', stats);
};

main()
  .catch(err => {
    console.error('[passdesk-import] ошибка:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pdPool.end().catch(() => undefined);
    await closeDb().catch(() => undefined);
  });
