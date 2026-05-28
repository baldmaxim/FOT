import { query, queryOne, withTransaction } from '../config/postgres.js';

export const CORRECTION_ATTACHMENT_ENTITY_TYPE = 'attendance_adjustment';
export const CORRECTION_ATTACHMENT_PURPOSE = 'timesheet_correction';

export interface ICorrectionAttachment {
  id: number;
  source: 'adjustment' | 'leave_request';
  original_name: string;
  mime_type: string | null;
  file_size: number;
  uploaded_at: string;
  uploader_name: string | null;
  r2_key: string;
}

interface ICorrectionAdjustmentMeta {
  id: number;
  employee_id: number;
  work_date: string;
  source_type: string;
  source_id: string | null;
}

export async function loadCorrectionAdjustmentById(
  adjustmentId: number,
): Promise<ICorrectionAdjustmentMeta | null> {
  const row = await queryOne<ICorrectionAdjustmentMeta>(
    `SELECT id, employee_id, work_date, source_type, source_id
       FROM attendance_adjustments
      WHERE id = $1`,
    [adjustmentId],
  );
  return row ?? null;
}

function leaveRequestIdFromAdjustment(adj: ICorrectionAdjustmentMeta): number | null {
  if (adj.source_type !== 'leave_request' || !adj.source_id) return null;
  const raw = adj.source_id.split(':', 1)[0];
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function fetchDocuments(documentIds: number[]): Promise<Array<{
  id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string | null;
  created_at: string;
}>> {
  if (documentIds.length === 0) return [];
  const rows = await query<{
    id: number | string;
    file_name: string;
    file_size: number | string;
    mime_type: string;
    r2_key: string;
    uploaded_by: string | null;
    created_at: string;
  }>(
    `SELECT id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at
       FROM documents
      WHERE id = ANY($1::int[])`,
    [documentIds],
  );
  return rows.map(row => ({
    id: Number(row.id),
    file_name: String(row.file_name),
    file_size: Number(row.file_size),
    mime_type: String(row.mime_type),
    r2_key: String(row.r2_key),
    uploaded_by: row.uploaded_by ? String(row.uploaded_by) : null,
    created_at: String(row.created_at),
  }));
}

async function fetchUploaderNames(uploadedByIds: Array<string | null>): Promise<Map<string, string | null>> {
  const ids = [...new Set(uploadedByIds.filter((value): value is string => Boolean(value)))];
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const profiles = await query<{ id: string; full_name: string | null }>(
    `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  for (const row of profiles) {
    out.set(String(row.id), row.full_name ?? null);
  }
  return out;
}

/**
 * Список файлов корректировки:
 *   1) собственные (entity_type='attendance_adjustment')
 *   2) подмешанные из связанной leave_request (read-only)
 */
export async function listCorrectionAttachments(adj: ICorrectionAdjustmentMeta): Promise<ICorrectionAttachment[]> {
  const ownLinks = await query<{ document_id: number | string }>(
    `SELECT document_id FROM document_links
       WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
    [CORRECTION_ATTACHMENT_ENTITY_TYPE, String(adj.id), CORRECTION_ATTACHMENT_PURPOSE],
  );
  const ownIds = new Set(ownLinks.map(link => Number(link.document_id)));

  const leaveRequestId = leaveRequestIdFromAdjustment(adj);
  const relatedIds = new Set<number>();
  if (leaveRequestId != null) {
    const relatedLinks = await query<{ document_id: number | string }>(
      `SELECT document_id FROM document_links
         WHERE entity_type = 'leave_request' AND entity_id = $1`,
      [String(leaveRequestId)],
    );
    for (const link of relatedLinks) {
      const id = Number(link.document_id);
      if (Number.isFinite(id) && !ownIds.has(id)) relatedIds.add(id);
    }
    // Legacy: documents.leave_request_id без записи в document_links
    const legacy = await query<{ id: number | string }>(
      `SELECT id FROM documents WHERE leave_request_id = $1`,
      [leaveRequestId],
    );
    for (const row of legacy) {
      const id = Number(row.id);
      if (Number.isFinite(id) && !ownIds.has(id)) relatedIds.add(id);
    }
  }

  const allIds = [...ownIds, ...relatedIds];
  const docs = await fetchDocuments(allIds);
  const uploaders = await fetchUploaderNames(docs.map(doc => doc.uploaded_by));

  return docs
    .map<ICorrectionAttachment>(doc => ({
      id: doc.id,
      source: ownIds.has(doc.id) ? 'adjustment' : 'leave_request',
      original_name: doc.file_name,
      mime_type: doc.mime_type || null,
      file_size: doc.file_size,
      uploaded_at: doc.created_at,
      uploader_name: doc.uploaded_by ? uploaders.get(doc.uploaded_by) ?? null : null,
      r2_key: doc.r2_key,
    }))
    .sort((left, right) => right.uploaded_at.localeCompare(left.uploaded_at));
}

/**
 * Batch-подсчёт суммарного числа вложений по id корректировок (own + leave_request related).
 */
export async function countCorrectionAttachments(
  adjustments: Array<{ id: number; source_type: string; source_id: string | null }>,
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (adjustments.length === 0) return counts;
  for (const adj of adjustments) counts.set(adj.id, 0);

  const ids = adjustments.map(adj => adj.id);
  const ownRows = await query<{ entity_id: string; cnt: number | string }>(
    `SELECT entity_id, COUNT(*)::int AS cnt FROM document_links
       WHERE entity_type = $1 AND purpose = $2 AND entity_id = ANY($3::text[])
     GROUP BY entity_id`,
    [CORRECTION_ATTACHMENT_ENTITY_TYPE, CORRECTION_ATTACHMENT_PURPOSE, ids.map(String)],
  );
  for (const row of ownRows) {
    const id = Number(row.entity_id);
    if (Number.isFinite(id)) counts.set(id, (counts.get(id) ?? 0) + Number(row.cnt));
  }

  const leaveRequestPairs: Array<{ adjId: number; lr: number }> = [];
  for (const adj of adjustments) {
    const lr = leaveRequestIdFromAdjustment(adj as ICorrectionAdjustmentMeta);
    if (lr != null) leaveRequestPairs.push({ adjId: adj.id, lr });
  }
  if (leaveRequestPairs.length > 0) {
    const lrIds = [...new Set(leaveRequestPairs.map(pair => pair.lr))];
    const lrRows = await query<{ entity_id: string; cnt: number | string }>(
      `SELECT entity_id, COUNT(*)::int AS cnt FROM document_links
         WHERE entity_type = 'leave_request' AND entity_id = ANY($1::text[])
       GROUP BY entity_id`,
      [lrIds.map(String)],
    );
    const lrCount = new Map<number, number>(
      lrRows.map(row => [Number(row.entity_id), Number(row.cnt)] as const),
    );
    // Legacy fallback (documents.leave_request_id без записи в document_links)
    const legacyRows = await query<{ leave_request_id: number | string; cnt: number | string }>(
      `SELECT leave_request_id, COUNT(*)::int AS cnt FROM documents
         WHERE leave_request_id = ANY($1::int[])
       GROUP BY leave_request_id`,
      [lrIds],
    );
    const legacyMap = new Map<number, number>(
      legacyRows.map(row => [Number(row.leave_request_id), Number(row.cnt)] as const),
    );
    for (const { adjId, lr } of leaveRequestPairs) {
      const fromLinks = lrCount.get(lr) ?? 0;
      const fromLegacy = legacyMap.get(lr) ?? 0;
      counts.set(adjId, (counts.get(adjId) ?? 0) + Math.max(fromLinks, fromLegacy));
    }
  }

  return counts;
}

export async function createCorrectionAttachment(params: {
  adjustmentId: number;
  employeeId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  r2Key: string;
  uploadedBy: string;
}): Promise<ICorrectionAttachment> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: number | string;
      file_name: string;
      file_size: number | string;
      mime_type: string;
      r2_key: string;
      uploaded_by: string;
      created_at: string;
    }>(
      `INSERT INTO documents
         (employee_id, leave_request_id, category, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
       RETURNING id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at`,
      [
        params.employeeId,
        CORRECTION_ATTACHMENT_PURPOSE,
        params.fileName,
        params.fileSize,
        params.mimeType,
        params.r2Key,
        params.uploadedBy,
      ],
    );
    const doc = result.rows[0];
    if (!doc) throw new Error('Failed to insert document');

    await client.query(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
      [doc.id, CORRECTION_ATTACHMENT_ENTITY_TYPE, String(params.adjustmentId), CORRECTION_ATTACHMENT_PURPOSE],
    );

    return {
      id: Number(doc.id),
      source: 'adjustment',
      original_name: String(doc.file_name),
      mime_type: String(doc.mime_type) || null,
      file_size: Number(doc.file_size),
      uploaded_at: String(doc.created_at),
      uploader_name: null,
      r2_key: String(doc.r2_key),
    };
  });
}

/**
 * Удаление собственного вложения корректировки. Возвращает r2_key (для удаления объекта)
 * и булев флаг — было ли это вложение действительно «своим» (для adjustment).
 * Если документ принадлежит только leave_request — возвращает {owned:false} без удаления.
 */
export async function deleteCorrectionAttachment(
  adjustmentId: number,
  documentId: number,
): Promise<{ owned: boolean; r2Key: string | null }> {
  const ownLink = await queryOne<{ document_id: number }>(
    `SELECT document_id FROM document_links
       WHERE document_id = $1 AND entity_type = $2 AND entity_id = $3 AND purpose = $4
       LIMIT 1`,
    [documentId, CORRECTION_ATTACHMENT_ENTITY_TYPE, String(adjustmentId), CORRECTION_ATTACHMENT_PURPOSE],
  );
  if (!ownLink) return { owned: false, r2Key: null };

  const doc = await queryOne<{ r2_key: string }>(
    `SELECT r2_key FROM documents WHERE id = $1 LIMIT 1`,
    [documentId],
  );
  const r2Key = doc ? String(doc.r2_key) : null;

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM document_links
        WHERE document_id = $1
          AND entity_type = $2
          AND entity_id = $3
          AND purpose = $4`,
      [documentId, CORRECTION_ATTACHMENT_ENTITY_TYPE, String(adjustmentId), CORRECTION_ATTACHMENT_PURPOSE],
    );
    // Документ корректировки уникально привязан к одной adjustment.
    // Безопасно удалить, если других ссылок не осталось.
    const others = await client.query<{ cnt: number | string }>(
      `SELECT COUNT(*)::int AS cnt FROM document_links WHERE document_id = $1`,
      [documentId],
    );
    if (Number(others.rows[0]?.cnt ?? 0) === 0) {
      await client.query(`DELETE FROM documents WHERE id = $1`, [documentId]);
    }
  });

  return { owned: true, r2Key };
}

/**
 * Удаляет все собственные вложения корректировки (для cascade при удалении adjustment).
 * Возвращает массив r2_key для post-cleanup в R2.
 */
export async function purgeCorrectionAttachments(adjustmentId: number): Promise<string[]> {
  const docs = await query<{ document_id: number | string; r2_key: string }>(
    `SELECT dl.document_id, d.r2_key
       FROM document_links dl
       JOIN documents d ON d.id = dl.document_id
      WHERE dl.entity_type = $1 AND dl.entity_id = $2 AND dl.purpose = $3`,
    [CORRECTION_ATTACHMENT_ENTITY_TYPE, String(adjustmentId), CORRECTION_ATTACHMENT_PURPOSE],
  );
  if (docs.length === 0) return [];

  const docIds = docs.map(row => Number(row.document_id));
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM document_links
        WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
      [CORRECTION_ATTACHMENT_ENTITY_TYPE, String(adjustmentId), CORRECTION_ATTACHMENT_PURPOSE],
    );
    const otherRows = await client.query<{ document_id: number | string }>(
      `SELECT document_id FROM document_links WHERE document_id = ANY($1::int[])`,
      [docIds],
    );
    const stillReferenced = new Set(otherRows.rows.map(row => Number(row.document_id)));
    const orphanIds = docIds.filter(id => !stillReferenced.has(id));
    if (orphanIds.length > 0) {
      await client.query(`DELETE FROM documents WHERE id = ANY($1::int[])`, [orphanIds]);
    }
  });

  return docs.map(row => String(row.r2_key));
}
