import type { Response } from 'express';
import { query, queryOne, execute } from '../config/postgres.js';
import { r2Service } from '../services/r2.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { canAccessEmployeeInScope, resolveScopedDepartmentId } from '../services/data-scope.service.js';
import { hasPageView } from '../services/access-control.service.js';
import { aiReceiptRecognitionService } from '../services/ai-receipt-recognition.service.js';
import { trimWhiteBorders } from '../services/image-trim.service.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

const DOCUMENT_SELECT_COLUMNS = 'id, employee_id, leave_request_id, category, file_name, file_size, mime_type, r2_key, uploaded_by, created_at, recognition_status, recognition_attempts, recognized_at';
const CATEGORY_CACHE_TTL_MS = 60_000;
let categoryCache: { codes: Set<string>; expiresAt: number } | null = null;

const isValidCategory = async (category: string): Promise<boolean> => {
  if (categoryCache && categoryCache.expiresAt > Date.now()) {
    return categoryCache.codes.has(category);
  }

  const rows = await query<{ code: string }>(`SELECT code FROM document_categories`);
  const codes = new Set(rows.map(row => String(row.code)));
  categoryCache = { codes, expiresAt: Date.now() + CATEGORY_CACHE_TTL_MS };
  return codes.has(category);
};

const ensureDocumentLinks = async (
  documentId: number,
  employeeId: number,
  category: string,
  leaveRequestId?: number | null,
): Promise<void> => {
  const links = [
    {
      document_id: documentId,
      entity_type: 'employee',
      entity_id: String(employeeId),
      purpose: category,
    },
  ];

  if (leaveRequestId) {
    links.push({
      document_id: documentId,
      entity_type: 'leave_request',
      entity_id: String(leaveRequestId),
      purpose: category,
    });
  }

  const params: unknown[] = [];
  const placeholders: string[] = [];
  for (const link of links) {
    const groupPlaceholders: string[] = [];
    for (const col of ['document_id', 'entity_type', 'entity_id', 'purpose'] as const) {
      params.push(link[col]);
      groupPlaceholders.push(`$${params.length}`);
    }
    placeholders.push(`(${groupPlaceholders.join(', ')})`);
  }
  await execute(
    `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
    params,
  );
};

const loadDocumentsByEmployeeId = async (employeeId: number): Promise<Record<string, unknown>[]> => {
  const links = await query<{ document_id: number }>(
    `SELECT document_id FROM document_links
       WHERE entity_type = 'employee' AND entity_id = $1`,
    [String(employeeId)],
  );

  const linkedIds = [...new Set(links.map(link => Number(link.document_id)).filter(Number.isFinite))];
  let linkedDocs: Record<string, unknown>[] = [];
  if (linkedIds.length > 0) {
    linkedDocs = await query<Record<string, unknown>>(
      `SELECT ${DOCUMENT_SELECT_COLUMNS} FROM documents WHERE id = ANY($1::int[])`,
      [linkedIds],
    );
  }

  const linkedIdSet = new Set(linkedDocs.map(doc => Number(doc.id)));
  const legacyDocs = await query<Record<string, unknown>>(
    `SELECT ${DOCUMENT_SELECT_COLUMNS} FROM documents
       WHERE employee_id = $1
       ORDER BY created_at DESC`,
    [employeeId],
  );

  const missingLegacyDocs = legacyDocs.filter(doc => !linkedIdSet.has(Number(doc.id)));
  if (missingLegacyDocs.length > 0) {
    await Promise.all(
      missingLegacyDocs.map(doc =>
        ensureDocumentLinks(
          Number(doc.id),
          employeeId,
          String(doc.category),
          typeof doc.leave_request_id === 'number' ? doc.leave_request_id : null,
        ).catch(() => undefined),
      ),
    );
  }

  return [...linkedDocs, ...missingLegacyDocs].sort(
    (left, right) => new Date(String(right.created_at)).getTime() - new Date(String(left.created_at)).getTime(),
  );
};

/** Загрузка файла через бэкенд (multipart) — кладёт в S3 и создаёт запись */
const uploadFile = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'R2 хранилище не настроено' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Файл обязателен' });
      return;
    }

    const employeeId = Number(req.body.employee_id);
    const category = String(req.body.category || '');
    const leaveRequestId = req.body.leave_request_id ? Number(req.body.leave_request_id) : null;

    if (!employeeId || Number.isNaN(employeeId) || !category) {
      res.status(400).json({ success: false, error: 'employee_id, category обязательны' });
      return;
    }
    if (!(await isValidCategory(category))) {
      res.status(400).json({ success: false, error: 'Недопустимая категория документа' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const file = req.file;
    let buffer = file.buffer;
    let mimeType = file.mimetype || 'application/octet-stream';
    let fileSize = file.size;
    const safeFileName = sanitizeFileName(decodeMulterFilename(file.originalname));

    if (category === 'patent_check') {
      const trimmed = await trimWhiteBorders(buffer, mimeType);
      buffer = trimmed.buffer;
      mimeType = trimmed.mimeType;
      fileSize = trimmed.size;
    }

    const r2Key = r2Service.generateKey(employeeId, safeFileName);

    await r2Service.uploadObject(r2Key, buffer, mimeType);

    let data: Record<string, unknown> | null;
    try {
      data = await queryOne<Record<string, unknown>>(
        `INSERT INTO documents
           (employee_id, leave_request_id, category, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${DOCUMENT_SELECT_COLUMNS}`,
        [employeeId, leaveRequestId, category, safeFileName, fileSize, mimeType, r2Key, req.user.id],
      );
    } catch (err) {
      try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
      throw err;
    }
    if (!data) {
      try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
      throw new Error('Не удалось создать документ');
    }

    await ensureDocumentLinks(Number(data.id), employeeId, category, leaveRequestId);
    res.json({ success: true, data });

    if (category === 'patent_check') {
      void aiReceiptRecognitionService.enqueueRecognition(Number(data.id));
    }
  } catch (err) {
    console.error('documents.uploadFile error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки документа' });
  }
};

/** Получить presigned URL для скачивания */
const getDownloadUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'R2 хранилище не настроено' });
      return;
    }

    const { id } = req.params;
    const doc = await queryOne<{
      id: number;
      employee_id: number | null;
      r2_key: string;
      file_name: string;
    }>(
      `SELECT ${DOCUMENT_SELECT_COLUMNS} FROM documents WHERE id = $1`,
      [id],
    );

    if (!doc) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }

    let allowed = false;
    if (doc.employee_id != null) {
      allowed = await canAccessEmployeeInScope(req, doc.employee_id);
    } else {
      const link = await queryOne<{ entity_type: string | null; entity_id: string | null }>(
        `SELECT entity_type, entity_id FROM document_links WHERE document_id = $1 LIMIT 1`,
        [doc.id],
      );
      if (link?.entity_type === 'timesheet_approval' && link.entity_id) {
        const approval = await queryOne<{ department_id: string | null }>(
          `SELECT department_id FROM timesheet_approvals WHERE id = $1`,
          [link.entity_id],
        );
        const deptId = approval?.department_id ? String(approval.department_id) : null;
        if (deptId) {
          const scoped = await resolveScopedDepartmentId(req, deptId);
          allowed = !!scoped && scoped === deptId;
          if (!allowed) {
            allowed = await hasPageView(req.user.role_code, '/timesheet-hr');
          }
        }
      }
    }
    if (!allowed) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }

    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
    const downloadUrl = await r2Service.generateDownloadUrl(doc.r2_key, doc.file_name, disposition);
    res.json({ success: true, data: { download_url: downloadUrl, file_name: doc.file_name } });
  } catch (err) {
    console.error('documents.getDownloadUrl error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения URL' });
  }
};

/** Мои документы (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await loadDocumentsByEmployeeId(employeeId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('documents.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения документов' });
  }
};

/** Документы по заявке */
const getByLeaveRequest = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const leaveRequestId = Number(req.params.leaveRequestId);
    if (!leaveRequestId || Number.isNaN(leaveRequestId)) {
      res.status(400).json({ success: false, error: 'Некорректный leave_request_id' });
      return;
    }

    const request = await queryOne<{ id: number; employee_id: number }>(
      `SELECT id, employee_id FROM leave_requests WHERE id = $1`,
      [leaveRequestId],
    );
    if (!request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, request.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }

    const links = await query<{ document_id: number }>(
      `SELECT document_id FROM document_links
         WHERE entity_type = 'leave_request' AND entity_id = $1`,
      [String(leaveRequestId)],
    );

    const linkedIds = [...new Set(links.map(link => Number(link.document_id)).filter(Number.isFinite))];

    const legacyDocs = await query<Record<string, unknown>>(
      `SELECT ${DOCUMENT_SELECT_COLUMNS} FROM documents
         WHERE leave_request_id = $1
         ORDER BY created_at DESC`,
      [leaveRequestId],
    );

    const docIds = new Set<number>(linkedIds);
    for (const doc of legacyDocs) docIds.add(Number(doc.id));

    if (docIds.size === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await query<Record<string, unknown>>(
      `SELECT ${DOCUMENT_SELECT_COLUMNS} FROM documents
         WHERE id = ANY($1::int[])
         ORDER BY created_at DESC`,
      [[...docIds]],
    );

    res.json({ success: true, data });
  } catch (err) {
    console.error('documents.getByLeaveRequest error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения документов заявки' });
  }
};

/** Документы сотрудника (header/hr/admin) */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!employeeId || Number.isNaN(employeeId)) {
      res.status(400).json({ success: false, error: 'Некорректный employee id' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const data = await loadDocumentsByEmployeeId(employeeId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('documents.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения документов' });
  }
};

/** Удаление документа (hr/admin) */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const doc = await queryOne<{ r2_key: string; employee_id: number | null }>(
      `SELECT r2_key, employee_id FROM documents WHERE id = $1`,
      [id],
    );

    if (!doc) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }
    if (doc.employee_id != null && !(await canAccessEmployeeInScope(req, doc.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    if (await r2Service.isEnabledAsync()) {
      try {
        await r2Service.deleteObject(doc.r2_key);
      } catch {
        // Не блокируем удаление записи из БД
      }
    }

    await execute(`DELETE FROM documents WHERE id = $1`, [id]);

    res.json({ success: true });
  } catch (err) {
    console.error('documents.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления документа' });
  }
};

export const documentsController = {
  uploadFile,
  getDownloadUrl,
  getMy,
  getByEmployee,
  getByLeaveRequest,
  remove,
};
