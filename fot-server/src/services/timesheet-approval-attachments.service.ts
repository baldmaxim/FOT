import { query, queryOne, withTransaction } from '../config/postgres.js';
import { r2Service } from './r2.service.js';

export const APPROVAL_ATTACHMENT_ENTITY_TYPE = 'timesheet_approval';
export const APPROVAL_ATTACHMENT_PURPOSE = 'weekend_confirmation';
export const APPROVAL_ATTACHMENT_CATEGORY = 'timesheet_weekend_confirmation';

export interface IApprovalAttachment {
  document_id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
}

export async function findOrCreateDraftApproval(params: {
  departmentId: string;
  startDate: string;
  endDate: string;
  userId: string;
}): Promise<{ id: number; status: string }> {
  const { departmentId, startDate, endDate } = params;

  const existing = await queryOne<{ id: number | string; status: string }>(
    `SELECT id, status FROM timesheet_approvals
       WHERE department_id = $1 AND start_date = $2 AND end_date = $3
       LIMIT 1`,
    [departmentId, startDate, endDate],
  );

  if (existing) {
    return { id: Number(existing.id), status: String(existing.status) };
  }

  const now = new Date().toISOString();
  const inserted = await queryOne<{ id: number | string; status: string }>(
    `INSERT INTO timesheet_approvals (department_id, start_date, end_date, status, updated_at)
       VALUES ($1, $2, $3, 'draft', $4)
       RETURNING id, status`,
    [departmentId, startDate, endDate, now],
  );
  if (!inserted) {
    throw new Error('Failed to create draft approval');
  }
  return { id: Number(inserted.id), status: String(inserted.status) };
}

export async function listApprovalAttachments(approvalId: number): Promise<IApprovalAttachment[]> {
  const links = await query<{ document_id: number | string }>(
    `SELECT document_id FROM document_links
       WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
    [APPROVAL_ATTACHMENT_ENTITY_TYPE, String(approvalId), APPROVAL_ATTACHMENT_PURPOSE],
  );
  const docIds = links.map(row => Number(row.document_id));
  if (docIds.length === 0) return [];

  const docs = await query<{
    id: number | string;
    file_name: string;
    file_size: number | string;
    mime_type: string;
    r2_key: string;
    uploaded_by: string;
    created_at: string;
  }>(
    `SELECT id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at
       FROM documents
       WHERE id = ANY($1::int[])
       ORDER BY created_at DESC`,
    [docIds],
  );

  const uploaderIds = [...new Set(docs.map(row => String(row.uploaded_by)).filter(Boolean))];
  const names = new Map<string, string | null>();
  if (uploaderIds.length > 0) {
    const profiles = await query<{ id: string; full_name: string | null }>(
      `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
      [uploaderIds],
    );
    for (const row of profiles) {
      names.set(String(row.id), row.full_name ?? null);
    }
  }

  return docs.map(row => ({
    document_id: Number(row.id),
    file_name: String(row.file_name),
    file_size: Number(row.file_size),
    mime_type: String(row.mime_type),
    r2_key: String(row.r2_key),
    uploaded_by: String(row.uploaded_by),
    uploaded_by_name: names.get(String(row.uploaded_by)) ?? null,
    created_at: String(row.created_at),
  }));
}

export async function countApprovalAttachments(approvalId: number): Promise<number> {
  const row = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM document_links
       WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
    [APPROVAL_ATTACHMENT_ENTITY_TYPE, String(approvalId), APPROVAL_ATTACHMENT_PURPOSE],
  );
  return row ? Number(row.count) : 0;
}

export async function createAttachmentRecord(params: {
  approvalId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  r2Key: string;
  uploadedBy: string;
}): Promise<IApprovalAttachment> {
  return withTransaction(async (client) => {
    const docResult = await client.query<{
      id: number | string;
      file_name: string;
      file_size: number | string;
      mime_type: string;
      r2_key: string;
      uploaded_by: string;
      created_at: string;
    }>(
      `INSERT INTO documents (employee_id, leave_request_id, category, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES (NULL, NULL, $1, $2, $3, $4, $5, $6)
         RETURNING id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at`,
      [
        APPROVAL_ATTACHMENT_CATEGORY,
        params.fileName,
        params.fileSize,
        params.mimeType,
        params.r2Key,
        params.uploadedBy,
      ],
    );
    const doc = docResult.rows[0];
    if (!doc) {
      throw new Error('Failed to insert document');
    }

    await client.query(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
         VALUES ($1, $2, $3, $4)`,
      [doc.id, APPROVAL_ATTACHMENT_ENTITY_TYPE, String(params.approvalId), APPROVAL_ATTACHMENT_PURPOSE],
    );

    return {
      document_id: Number(doc.id),
      file_name: String(doc.file_name),
      file_size: Number(doc.file_size),
      mime_type: String(doc.mime_type),
      r2_key: String(doc.r2_key),
      uploaded_by: String(doc.uploaded_by),
      uploaded_by_name: null,
      created_at: String(doc.created_at),
    };
  });
}

export async function deleteAttachmentRecord(documentId: number): Promise<{ deleted: boolean; r2Key: string | null; approvalId: number | null }> {
  const link = await queryOne<{ entity_id: string }>(
    `SELECT entity_id FROM document_links
       WHERE document_id = $1 AND entity_type = $2 AND purpose = $3
       LIMIT 1`,
    [documentId, APPROVAL_ATTACHMENT_ENTITY_TYPE, APPROVAL_ATTACHMENT_PURPOSE],
  );
  const approvalId = link ? Number(link.entity_id) : null;

  const doc = await queryOne<{ r2_key: string }>(
    `SELECT r2_key FROM documents WHERE id = $1 LIMIT 1`,
    [documentId],
  );
  const r2Key = doc ? String(doc.r2_key) : null;

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM document_links WHERE document_id = $1`, [documentId]);
    await client.query(`DELETE FROM documents WHERE id = $1`, [documentId]);
  });

  if (r2Key) {
    try {
      await r2Service.deleteObject(r2Key);
    } catch (err) {
      console.warn('timesheet-approval-attachments.delete: r2 delete failed', err);
    }
  }

  return { deleted: Boolean(doc), r2Key, approvalId };
}
