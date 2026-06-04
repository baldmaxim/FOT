import { query, queryOne, withTransaction } from '../config/postgres.js';
import { r2Service } from './r2.service.js';
import { listApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';

export const APPROVAL_ATTACHMENT_ENTITY_TYPE = 'timesheet_approval';
export const APPROVAL_ATTACHMENT_PURPOSE = 'weekend_confirmation';
export const APPROVAL_ATTACHMENT_CATEGORY = 'timesheet_weekend_confirmation';

// Файлы корректировок (entity_type/purpose из correction-attachments.service.ts).
const CORRECTION_ATTACHMENT_ENTITY_TYPE = 'attendance_adjustment';
const CORRECTION_ATTACHMENT_PURPOSE = 'timesheet_correction';

export interface IApprovalAttachment {
  document_id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
  /** Тип вложения: служебка о выходных или файл корректировки. Заполняется агрегатором. */
  kind?: 'weekend_memo' | 'correction';
  /** Для корректировок — ФИО сотрудника и дата дня (контекст в едином списке). */
  employee_name?: string | null;
  work_date?: string | null;
  /** Подписанные URL (агрегатор отдаёт их сразу — у корректировок свой авторизационный путь). */
  download_url?: string;
  preview_url?: string;
}

export async function findOrCreateDraftApproval(params: {
  departmentId: string | null;
  managerEmployeeId: number | null;
  startDate: string;
  endDate: string;
  userId: string;
}): Promise<{ id: number; status: string }> {
  const { departmentId, managerEmployeeId, startDate, endDate } = params;

  if ((departmentId == null) === (managerEmployeeId == null)) {
    throw new Error('findOrCreateDraftApproval: ровно одно из departmentId/managerEmployeeId должно быть указано');
  }

  const existing = managerEmployeeId != null
    ? await queryOne<{ id: number | string; status: string }>(
        `SELECT id, status FROM timesheet_approvals
           WHERE manager_employee_id = $1 AND start_date = $2 AND end_date = $3
           LIMIT 1`,
        [managerEmployeeId, startDate, endDate],
      )
    : await queryOne<{ id: number | string; status: string }>(
        `SELECT id, status FROM timesheet_approvals
           WHERE department_id = $1 AND start_date = $2 AND end_date = $3
             AND manager_employee_id IS NULL
           LIMIT 1`,
        [departmentId, startDate, endDate],
      );

  if (existing) {
    return { id: Number(existing.id), status: String(existing.status) };
  }

  const now = new Date().toISOString();
  const inserted = await queryOne<{ id: number | string; status: string }>(
    `INSERT INTO timesheet_approvals (department_id, manager_employee_id, start_date, end_date, status, updated_at)
       VALUES ($1, $2, $3, $4, 'draft', $5)
       RETURNING id, status`,
    [departmentId, managerEmployeeId, startDate, endDate, now],
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

/**
 * Единый список вложений периода подачи: служебка о выходных (weekend-memo, привязка к
 * approval) + файлы корректировок всех сотрудников снимка за период (привязка к
 * attendance_adjustment). Отдаёт подписанные URL прямо в ответе — у файлов корректировок
 * свой авторизационный путь, отдельный getAttachmentDownloadUrl на них не работает.
 */
export async function listApprovalPeriodAttachments(approvalId: number): Promise<IApprovalAttachment[]> {
  const r2Enabled = await r2Service.isEnabledAsync();
  const signUrls = async (item: IApprovalAttachment): Promise<IApprovalAttachment> => {
    if (!r2Enabled) return item;
    return {
      ...item,
      download_url: await r2Service.generateDownloadUrl(item.r2_key, item.file_name),
      preview_url: await r2Service.generateDownloadUrl(item.r2_key, item.file_name, 'inline'),
    };
  };

  // 1. Служебка о выходных (как раньше).
  const weekendDocs = await listApprovalAttachments(approvalId);
  const weekendItems = await Promise.all(
    weekendDocs.map(doc => signUrls({ ...doc, kind: 'weekend_memo', employee_name: null, work_date: null })),
  );

  // 2. Период подачи + состав сотрудников из снимка.
  const approval = await queryOne<{ start_date: string; end_date: string }>(
    `SELECT start_date, end_date FROM timesheet_approvals WHERE id = $1 LIMIT 1`,
    [approvalId],
  );
  if (!approval) return weekendItems;

  const snapshot = await listApprovalEmployees(approvalId);
  const employeeIds = snapshot.map(s => Number(s.employee_id)).filter(id => Number.isInteger(id) && id > 0);
  if (employeeIds.length === 0) return weekendItems;
  const nameById = new Map<number, string | null>(snapshot.map(s => [Number(s.employee_id), s.full_name ?? null] as const));

  // 3. Корректировки периода (id → сотрудник, дата).
  const adjustments = await query<{ id: number | string; employee_id: number | string; work_date: string }>(
    `SELECT id, employee_id, work_date
       FROM attendance_adjustments
      WHERE employee_id = ANY($1::int[])
        AND work_date >= $2 AND work_date <= $3`,
    [employeeIds, approval.start_date, approval.end_date],
  );
  if (adjustments.length === 0) return weekendItems;
  const adjMeta = new Map<string, { employeeId: number; workDate: string }>();
  for (const a of adjustments) {
    adjMeta.set(String(a.id), { employeeId: Number(a.employee_id), workDate: String(a.work_date) });
  }

  // 4. Ссылки на файлы корректировок этих adjustment.
  const links = await query<{ entity_id: string; document_id: number | string }>(
    `SELECT entity_id, document_id FROM document_links
      WHERE entity_type = $1 AND purpose = $2 AND entity_id = ANY($3::text[])`,
    [CORRECTION_ATTACHMENT_ENTITY_TYPE, CORRECTION_ATTACHMENT_PURPOSE, [...adjMeta.keys()]],
  );
  if (links.length === 0) return weekendItems;
  const docIdToAdj = new Map<number, string>();
  for (const l of links) docIdToAdj.set(Number(l.document_id), String(l.entity_id));
  const docIds = [...new Set(links.map(l => Number(l.document_id)))];

  const docs = await query<{
    id: number | string;
    file_name: string;
    file_size: number | string;
    mime_type: string;
    r2_key: string;
    uploaded_by: string | null;
    created_at: string;
  }>(
    `SELECT id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at
       FROM documents WHERE id = ANY($1::int[])`,
    [docIds],
  );

  const uploaderIds = [...new Set(docs.map(d => String(d.uploaded_by)).filter(Boolean))];
  const uploaderNames = new Map<string, string | null>();
  if (uploaderIds.length > 0) {
    const profiles = await query<{ id: string; full_name: string | null }>(
      `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
      [uploaderIds],
    );
    for (const p of profiles) uploaderNames.set(String(p.id), p.full_name ?? null);
  }

  const correctionItems = await Promise.all(
    docs.map(doc => {
      const adjId = docIdToAdj.get(Number(doc.id));
      const meta = adjId ? adjMeta.get(adjId) : undefined;
      return signUrls({
        document_id: Number(doc.id),
        file_name: String(doc.file_name),
        file_size: Number(doc.file_size),
        mime_type: String(doc.mime_type),
        r2_key: String(doc.r2_key),
        uploaded_by: doc.uploaded_by ? String(doc.uploaded_by) : '',
        uploaded_by_name: doc.uploaded_by ? uploaderNames.get(String(doc.uploaded_by)) ?? null : null,
        created_at: String(doc.created_at),
        kind: 'correction',
        employee_name: meta ? nameById.get(meta.employeeId) ?? null : null,
        work_date: meta?.workDate ?? null,
      });
    }),
  );

  correctionItems.sort((a, b) => {
    const d = String(a.work_date ?? '').localeCompare(String(b.work_date ?? ''));
    if (d !== 0) return d;
    return String(a.employee_name ?? '').localeCompare(String(b.employee_name ?? ''));
  });

  return [...weekendItems, ...correctionItems];
}

export async function countApprovalAttachments(approvalId: number): Promise<number> {
  const row = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM document_links
       WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
    [APPROVAL_ATTACHMENT_ENTITY_TYPE, String(approvalId), APPROVAL_ATTACHMENT_PURPOSE],
  );
  return row ? Number(row.count) : 0;
}

/**
 * Количество служебок, привязанных к любой из строк подачи (entity_id хранится как text).
 * При сабмите файл мог быть загружен на точный черновик диапазона, а консолидируется
 * на другую пересекающуюся строку — считаем по всем кандидатам.
 */
export async function countApprovalAttachmentsForApprovals(approvalIds: number[]): Promise<number> {
  const ids = [...new Set(approvalIds)].filter(id => Number.isInteger(id) && id > 0).map(String);
  if (ids.length === 0) return 0;
  const row = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM document_links
       WHERE entity_type = $1 AND purpose = $2 AND entity_id = ANY($3::text[])`,
    [APPROVAL_ATTACHMENT_ENTITY_TYPE, APPROVAL_ATTACHMENT_PURPOSE, ids],
  );
  return row ? Number(row.count) : 0;
}

/**
 * Перевешивает ссылки на служебки с вытесняемых строк подачи на выжившую.
 * Вызывается ВНУТРИ транзакции сабмита перед удалением toDeleteIds, иначе
 * document_links осиротеют и файл потеряется. Работает на переданном client.
 */
export async function relinkApprovalAttachments(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  fromApprovalIds: number[],
  toApprovalId: number,
): Promise<void> {
  const fromIds = [...new Set(fromApprovalIds)]
    .filter(id => Number.isInteger(id) && id > 0 && id !== toApprovalId)
    .map(String);
  if (fromIds.length === 0) return;
  await client.query(
    `UPDATE document_links
        SET entity_id = $1
      WHERE entity_type = $2 AND purpose = $3 AND entity_id = ANY($4::text[])`,
    [String(toApprovalId), APPROVAL_ATTACHMENT_ENTITY_TYPE, APPROVAL_ATTACHMENT_PURPOSE, fromIds],
  );
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
