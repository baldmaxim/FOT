/**
 * Документы подрядчика (миграция 127).
 *
 * Привязаны к организации (org_department_id), не к конкретной заявке —
 * подрядчик грузит их в любое время на странице пропусков, админ видит
 * актуальный список в модалке заявки на согласование.
 *
 * Хранилище: R2 (контейнер из r2.service.ts). Ключ:
 *   contractor-documents/{org_id}/{uuid}{ext}
 */
import { randomUUID } from 'crypto';
import path from 'path';
import { query, queryOne, execute } from '../config/postgres.js';
import { r2Service } from './r2.service.js';

export interface IContractorDocument {
  id: string;
  org_department_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string | null;
  created_at: string;
}

const SELECT_COLUMNS = `id, org_department_id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at`;

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_FILES_PER_ORG = 50;            // защитный лимит на общее число
export const ALLOWED_MIME_TYPES = new Set<string>([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
]);

const buildKey = (orgId: string, fileName: string): string => {
  const ext = (path.extname(fileName) || '.bin').toLowerCase();
  return `contractor-documents/${orgId}/${randomUUID()}${ext}`;
};

const sanitizeFileName = (raw: string): string => {
  const trimmed = (raw || 'file').trim();
  // убираем недопустимые символы для имени файла; путь не оставляем
  return trimmed
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 200) || 'file';
};

export const listOrgDocuments = async (orgId: string): Promise<IContractorDocument[]> => {
  return query<IContractorDocument>(
    `SELECT ${SELECT_COLUMNS}
       FROM contractor_documents
      WHERE org_department_id = $1::uuid
      ORDER BY created_at DESC`,
    [orgId],
  );
};

export const getOrgDocumentsCount = async (orgId: string): Promise<number> => {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM contractor_documents WHERE org_department_id = $1::uuid`,
    [orgId],
  );
  return Number(row?.count ?? 0);
};

export interface IUploadInput {
  orgId: string;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
  uploadedBy: string;
}

export const uploadOrgDocument = async (input: IUploadInput): Promise<IContractorDocument> => {
  if (!(await r2Service.isEnabledAsync())) {
    throw new Error('R2 хранилище не настроено');
  }
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new Error('Недопустимый тип файла. Разрешены PDF, JPG, PNG');
  }
  if (input.buffer.length > MAX_FILE_SIZE) {
    throw new Error('Файл больше 10 МБ');
  }
  const existing = await getOrgDocumentsCount(input.orgId);
  if (existing >= MAX_FILES_PER_ORG) {
    throw new Error(`Достигнут лимит документов на организацию (${MAX_FILES_PER_ORG})`);
  }

  const fileName = sanitizeFileName(input.fileName);
  const r2Key = buildKey(input.orgId, fileName);

  await r2Service.uploadObject(r2Key, input.buffer, input.mimeType);

  try {
    const row = await queryOne<IContractorDocument>(
      `INSERT INTO contractor_documents
         (org_department_id, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)
       RETURNING ${SELECT_COLUMNS}`,
      [input.orgId, fileName, input.buffer.length, input.mimeType, r2Key, input.uploadedBy],
    );
    if (!row) throw new Error('Не удалось сохранить документ');
    return row;
  } catch (e) {
    try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
    throw e;
  }
};

export const deleteOrgDocument = async (orgId: string, docId: string): Promise<void> => {
  const doc = await queryOne<{ r2_key: string }>(
    `SELECT r2_key FROM contractor_documents
      WHERE id = $1::uuid AND org_department_id = $2::uuid`,
    [docId, orgId],
  );
  if (!doc) throw new Error('Документ не найден');
  await execute('DELETE FROM contractor_documents WHERE id = $1::uuid', [docId]);
  try { await r2Service.deleteObject(doc.r2_key); } catch (e) {
    console.error('contractor-documents: delete r2 warning', e);
  }
};

export const getOrgDocumentDownloadUrl = async (
  docId: string,
  orgId: string | null,
): Promise<{ url: string; file_name: string } | null> => {
  const sql = orgId
    ? `SELECT r2_key, file_name FROM contractor_documents
        WHERE id = $1::uuid AND org_department_id = $2::uuid`
    : `SELECT r2_key, file_name FROM contractor_documents WHERE id = $1::uuid`;
  const params = orgId ? [docId, orgId] : [docId];
  const doc = await queryOne<{ r2_key: string; file_name: string }>(sql, params);
  if (!doc) return null;
  const url = await r2Service.generateDownloadUrl(doc.r2_key);
  return { url, file_name: doc.file_name };
};
