/**
 * Сканы кадрового профиля (категории hr_*): загрузка с прикладным шифрованием,
 * список по слотам, выдача расшифрованных байтов (только backend-stream),
 * soft-delete, перевешивание с черновика на сотрудника.
 *
 * Общий Documents API категории hr_* не отдаёт (см. documents.controller).
 */
import axios from 'axios';
import type { PoolClient } from 'pg';
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { getHrDocumentType, isHrCategory, toHrCategory, type IHrDocumentType } from '../config/hr-documents.js';
import { r2Service } from './r2.service.js';
import { ensureBrowserFriendlyImage, isHeicBuffer } from './image-normalize.service.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decryptFileBuffer, decryptJson, encryptFileBuffer, sha256Hex } from './hr-crypto.service.js';
import { recordHistory, type IHrActor } from './hr-profile.service.js';
import { enqueueHrOcr } from './hr-ocr/worker.js';
import type { IOcrNormalized } from './hr-ocr/normalize.js';

export const HR_FILE_MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export interface IHrDocumentRow {
  id: number;
  employee_id: number | null;
  category: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  created_at: string;
  deleted_at: string | null;
  recognition_status: 'pending' | 'processing' | 'done' | 'failed' | 'needs_review' | null;
  recognition_attempts: number | null;
  recognized_at: string | null;
  recognition_error: string | null;
  recognition_result_enc: string | null;
  recognition_key_version: string | null;
  file_enc_algorithm: string | null;
  file_enc_iv: string | null;
  file_enc_tag: string | null;
  file_enc_key_version: string | null;
  sha256: string | null;
}

export const HR_DOC_COLUMNS = `id, employee_id, category, file_name, file_size, mime_type, r2_key, uploaded_by, created_at, deleted_at,
  recognition_status, recognition_attempts, recognized_at, recognition_error, recognition_result_enc, recognition_key_version,
  file_enc_algorithm, file_enc_iv, file_enc_tag, file_enc_key_version, sha256`;

export interface IHrDocumentPublic {
  id: number;
  category: string;
  type_code: string;
  type_label: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  created_at: string;
  uploaded_by: string;
  recognition_status: IHrDocumentRow['recognition_status'];
  recognition_error: string | null;
  recognized_at: string | null;
  ocr_supported: boolean;
}

export interface IHrDocumentSlot {
  code: string;
  label: string;
  required: boolean;
  ocr_supported: boolean;
  files: IHrDocumentPublic[];
}

export class HrDocumentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HrDocumentError';
  }
}

const detectMime = (buffer: Buffer, declared: string): string | null => {
  if (buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (isHeicBuffer(buffer)) return 'image/heic';
  return ALLOWED_MIME.has(declared) ? null : null;
};

export const toPublic = (row: IHrDocumentRow): IHrDocumentPublic => {
  const type = getHrDocumentType(row.category);
  return {
    id: Number(row.id),
    category: row.category,
    type_code: type?.code ?? row.category,
    type_label: type?.label ?? row.category,
    file_name: row.file_name,
    file_size: Number(row.file_size),
    mime_type: row.mime_type,
    created_at: row.created_at,
    uploaded_by: row.uploaded_by,
    recognition_status: row.recognition_status,
    recognition_error: row.recognition_error,
    recognized_at: row.recognized_at,
    ocr_supported: !!type?.ocrType,
  };
};

export interface IUploadTarget {
  employeeId?: number | null;
  draftId?: string | null;
}

export interface IUploadInput {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
  typeCode: string;
  uploadedBy: string;
  actorName?: string | null;
  /** Тип паспорта для маршрутизации OCR (passport → passport_rf|foreign_passport). */
  passportType?: 'russian' | 'foreign' | null;
  /** Перенос из PassDesk: без постановки в OCR, история с источником migration. */
  skipOcr?: boolean;
  historySource?: 'admin' | 'migration';
  /** Дата загрузки в источнике (перенос) — сохраняем как created_at. */
  createdAt?: string | null;
}

/** Загрузка скана: валидация → sha256 → строка documents → шифрование (AAD=id) → R2 → метаданные → линк → OCR. */
export const uploadHrDocument = async (target: IUploadTarget, input: IUploadInput): Promise<IHrDocumentRow> => {
  if (!target.employeeId && !target.draftId) throw new HrDocumentError('Не указан владелец документа', 400);
  const type: IHrDocumentType | null = getHrDocumentType(input.typeCode);
  if (!type) throw new HrDocumentError('Недопустимый тип документа', 400);
  if (!(await r2Service.isEnabledAsync())) throw new HrDocumentError('Хранилище файлов не настроено', 503);
  if (input.buffer.length === 0) throw new HrDocumentError('Пустой файл', 400);
  if (input.buffer.length > HR_FILE_MAX_BYTES) throw new HrDocumentError('Файл больше 10 МБ', 413);

  let buffer = input.buffer;
  let mimeType = detectMime(buffer, input.mimeType);
  let fileName = sanitizeFileName(input.originalName);
  if (mimeType === 'image/heic') {
    const normalized = await ensureBrowserFriendlyImage(buffer, 'image/heic', fileName);
    if (normalized.mimeType !== 'image/jpeg') throw new HrDocumentError('Не удалось конвертировать HEIC', 415);
    buffer = normalized.buffer;
    mimeType = 'image/jpeg';
    fileName = normalized.fileName;
  }
  if (!mimeType || !ALLOWED_MIME.has(mimeType)) {
    throw new HrDocumentError('Допустимы только JPEG, PNG, WebP, HEIC и PDF', 415);
  }

  const sha256 = sha256Hex(buffer);
  const category = toHrCategory(type.code);
  const ownerKey = target.employeeId ? String(target.employeeId) : `hr-draft-${target.draftId}`;
  const r2Key = r2Service.generateKey(ownerKey, fileName);

  const willOcr = !!type.ocrType && !input.skipOcr;
  const row = await queryOne<IHrDocumentRow>(
    `INSERT INTO documents (employee_id, category, file_name, file_size, mime_type, r2_key, uploaded_by, sha256, recognition_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()))
     RETURNING ${HR_DOC_COLUMNS}`,
    [target.employeeId ?? null, category, fileName, buffer.length, mimeType, r2Key, input.uploadedBy, sha256, willOcr ? 'pending' : null, input.createdAt ?? null],
  );
  if (!row) throw new Error('INSERT documents не вернул строку');

  try {
    const { buffer: encrypted, meta } = encryptFileBuffer(buffer, row.id);
    await r2Service.uploadObject(r2Key, encrypted, 'application/octet-stream');
    await execute(
      `UPDATE documents SET file_enc_algorithm = $2, file_enc_iv = $3, file_enc_tag = $4, file_enc_key_version = $5 WHERE id = $1`,
      [row.id, meta.algorithm, meta.iv, meta.tag, meta.keyVersion],
    );
    const entityType = target.employeeId ? 'employee' : 'hr_draft';
    const entityId = target.employeeId ? String(target.employeeId) : String(target.draftId);
    await execute(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose) VALUES ($1, $2, $3, $4)
       ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
      [row.id, entityType, entityId, category],
    );
  } catch (err) {
    await execute(`DELETE FROM documents WHERE id = $1`, [row.id]).catch(() => undefined);
    try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
    throw err;
  }

  if (target.employeeId) {
    await recordHistory(null, target.employeeId, 'file_upload', {
      documentId: row.id,
      actor: { userId: input.uploadedBy, userName: input.actorName ?? undefined },
      source: input.historySource ?? 'admin',
    });
  }
  if (willOcr) {
    await enqueueHrOcr(row.id, { passportType: input.passportType ?? null });
  }
  return { ...row, file_enc_algorithm: 'aes-256-gcm' };
};

export const loadHrDocument = async (documentId: number, client?: PoolClient): Promise<IHrDocumentRow | null> => {
  const sql = `SELECT ${HR_DOC_COLUMNS} FROM documents WHERE id = $1`;
  const row = client ? (await client.query<IHrDocumentRow>(sql, [documentId])).rows[0] ?? null : await queryOne<IHrDocumentRow>(sql, [documentId]);
  if (!row || !isHrCategory(row.category)) return null;
  return row;
};

/** Владелец документа: сотрудник или черновик (по document_links). */
export const resolveHrDocumentOwner = async (documentId: number): Promise<{ employeeId: number | null; draftId: string | null }> => {
  const links = await query<{ entity_type: string; entity_id: string }>(
    `SELECT entity_type, entity_id FROM document_links WHERE document_id = $1 AND entity_type IN ('employee', 'hr_draft')`,
    [documentId],
  );
  const emp = links.find(l => l.entity_type === 'employee');
  const draft = links.find(l => l.entity_type === 'hr_draft');
  return { employeeId: emp ? Number(emp.entity_id) : null, draftId: draft ? draft.entity_id : null };
};

const listRows = async (where: string, params: unknown[]): Promise<IHrDocumentRow[]> =>
  query<IHrDocumentRow>(
    `SELECT ${HR_DOC_COLUMNS} FROM documents d
      WHERE d.deleted_at IS NULL AND d.category LIKE 'hr\\_%' AND ${where}
      ORDER BY d.created_at DESC, d.id DESC`,
    params,
  );

export const listEmployeeHrDocumentRows = async (employeeId: number): Promise<IHrDocumentRow[]> =>
  listRows(`d.employee_id = $1`, [employeeId]);

export const listDraftHrDocumentRows = async (draftId: string): Promise<IHrDocumentRow[]> =>
  listRows(`d.id IN (SELECT document_id FROM document_links WHERE entity_type = 'hr_draft' AND entity_id = $1)`, [draftId]);

/** Слоты по профилю комплекта + файлы в них (файлы вне профиля — в конец, без required). */
export const groupIntoSlots = (rows: IHrDocumentRow[], slots: { all: string[]; required: string[] }): IHrDocumentSlot[] => {
  const required = new Set(slots.required);
  const byCode = new Map<string, IHrDocumentPublic[]>();
  for (const row of rows) {
    const pub = toPublic(row);
    const list = byCode.get(pub.type_code) ?? [];
    list.push(pub);
    byCode.set(pub.type_code, list);
  }
  const out: IHrDocumentSlot[] = [];
  const seen = new Set<string>();
  for (const code of slots.all) {
    const type = getHrDocumentType(code);
    if (!type) continue;
    seen.add(code);
    out.push({ code, label: type.label, required: required.has(code), ocr_supported: !!type.ocrType, files: byCode.get(code) ?? [] });
  }
  for (const [code, files] of byCode) {
    if (seen.has(code)) continue;
    const type = getHrDocumentType(code);
    out.push({ code, label: type?.label ?? code, required: false, ocr_supported: !!type?.ocrType, files });
  }
  return out;
};

export const countCompleteness = (rows: IHrDocumentRow[], slots: { all: string[]; required: string[] }): { filled: number; required: number; total: number } => {
  const present = new Set(rows.map(r => getHrDocumentType(r.category)?.code ?? r.category));
  return {
    filled: slots.required.filter(code => present.has(code)).length,
    required: slots.required.length,
    total: rows.length,
  };
};

/** Скачать из R2 и расшифровать. */
export const loadDecryptedBytes = async (row: IHrDocumentRow): Promise<Buffer> => {
  const url = await r2Service.generateDownloadUrl(row.r2_key);
  const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 30_000 });
  const encrypted = Buffer.from(res.data);
  if (!row.file_enc_algorithm) return encrypted; // незашифрованный (не должно быть для hr_*, но перенос мог оставить)
  return decryptFileBuffer(encrypted, row.id, {
    algorithm: row.file_enc_algorithm,
    iv: row.file_enc_iv ?? '',
    tag: row.file_enc_tag ?? '',
    keyVersion: row.file_enc_key_version ?? '',
  });
};

export const softDeleteHrDocument = async (row: IHrDocumentRow, actor: IHrActor): Promise<void> => {
  await execute(`UPDATE documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [row.id]);
  await execute(`DELETE FROM hr_ocr_jobs WHERE document_id = $1`, [row.id]).catch(() => undefined);
  if (row.employee_id) {
    await recordHistory(null, row.employee_id, 'file_delete', { documentId: row.id, actor, source: 'admin' });
  }
};

/** Отложенная чистка R2 для soft-deleted старше N дней (вызывает планировщик). */
export const purgeDeletedHrDocuments = async (olderThanDays = 7): Promise<number> => {
  const rows = await query<{ id: number; r2_key: string }>(
    `SELECT id, r2_key FROM documents WHERE category LIKE 'hr\\_%' AND deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' days')::interval LIMIT 200`,
    [String(olderThanDays)],
  );
  let purged = 0;
  for (const row of rows) {
    try {
      await r2Service.deleteObject(row.r2_key);
      await execute(`DELETE FROM document_links WHERE document_id = $1`, [row.id]);
      await execute(`DELETE FROM documents WHERE id = $1`, [row.id]);
      purged += 1;
    } catch (err) {
      console.warn('[hr-documents] purge failed', { id: row.id, message: err instanceof Error ? err.message : err });
    }
  }
  return purged;
};

/** Перевесить сканы черновика на созданного/существующего сотрудника (идемпотентно). */
export const attachDraftDocumentsToEmployee = async (client: PoolClient, draftId: string, employeeId: number): Promise<number[]> => {
  const links = await client.query<{ document_id: number }>(
    `SELECT document_id FROM document_links WHERE entity_type = 'hr_draft' AND entity_id = $1`,
    [draftId],
  );
  const ids = links.rows.map(r => Number(r.document_id));
  if (ids.length === 0) return [];
  await client.query(`UPDATE documents SET employee_id = $2 WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids, employeeId]);
  await client.query(
    `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
     SELECT d.id, 'employee', $2, d.category FROM documents d WHERE d.id = ANY($1::bigint[])
     ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
    [ids, String(employeeId)],
  );
  await client.query(`DELETE FROM document_links WHERE entity_type = 'hr_draft' AND entity_id = $1`, [draftId]);
  return ids;
};

export const readRecognitionResult = (row: IHrDocumentRow): IOcrNormalized | null =>
  decryptJson<IOcrNormalized>(row.recognition_result_enc);

export const withTx = withTransaction;
