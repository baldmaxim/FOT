import type { Response } from 'express';
import { supabase } from '../config/database.js';
import { r2Service } from '../services/r2.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { canAccessEmployeeInScope, resolveScopedDepartmentId } from '../services/data-scope.service.js';
import { hasPageView } from '../services/access-control.service.js';
import { aiReceiptRecognitionService } from '../services/ai-receipt-recognition.service.js';
import { trimWhiteBorders } from '../services/image-trim.service.js';

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

  const { data, error } = await supabase
    .from('document_categories')
    .select('code');

  if (error) {
    throw error;
  }

  const codes = new Set((data || []).map(row => String(row.code)));
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

  const { error } = await supabase
    .from('document_links')
    .upsert(links, { onConflict: 'document_id,entity_type,entity_id,purpose' });

  if (error) {
    throw error;
  }
};

const loadDocumentsByEmployeeId = async (employeeId: number): Promise<Record<string, unknown>[]> => {
  const { data: links, error: linksError } = await supabase
    .from('document_links')
    .select('document_id')
    .eq('entity_type', 'employee')
    .eq('entity_id', String(employeeId));

  if (linksError) {
    throw linksError;
  }

  const linkedIds = [...new Set((links || []).map(link => Number(link.document_id)).filter(Number.isFinite))];
  let linkedDocs: Record<string, unknown>[] = [];
  if (linkedIds.length > 0) {
    const { data, error } = await supabase
      .from('documents')
      .select(DOCUMENT_SELECT_COLUMNS)
      .in('id', linkedIds);

    if (error) {
      throw error;
    }

    linkedDocs = (data || []) as Record<string, unknown>[];
  }

  const linkedIdSet = new Set(linkedDocs.map(doc => Number(doc.id)));
  const { data: legacyDocs, error: legacyError } = await supabase
    .from('documents')
    .select(DOCUMENT_SELECT_COLUMNS)
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false });

  if (legacyError) {
    throw legacyError;
  }

  const missingLegacyDocs = (legacyDocs || []).filter(doc => !linkedIdSet.has(Number(doc.id)));
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

    if (category === 'patent_check') {
      const trimmed = await trimWhiteBorders(buffer, mimeType);
      buffer = trimmed.buffer;
      mimeType = trimmed.mimeType;
      fileSize = trimmed.size;
    }

    const r2Key = r2Service.generateKey(employeeId, file.originalname);

    await r2Service.uploadObject(r2Key, buffer, mimeType);

    const { data, error } = await supabase
      .from('documents')
      .insert({
        employee_id: employeeId,
        leave_request_id: leaveRequestId,
        category,
        file_name: file.originalname,
        file_size: fileSize,
        mime_type: mimeType,
        r2_key: r2Key,
        uploaded_by: req.user.id,
      })
      .select()
      .single();

    if (error) {
      try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
      throw error;
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
    const { data: doc, error } = await supabase
      .from('documents')
      .select(DOCUMENT_SELECT_COLUMNS)
      .eq('id', id)
      .single();

    if (error || !doc) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }

    let allowed = false;
    if (doc.employee_id != null) {
      allowed = await canAccessEmployeeInScope(req, doc.employee_id);
    } else {
      const linkRes = await supabase
        .from('document_links')
        .select('entity_type, entity_id')
        .eq('document_id', doc.id)
        .maybeSingle();
      if (linkRes.error) throw linkRes.error;
      const link = linkRes.data as { entity_type?: string; entity_id?: string } | null;
      if (link?.entity_type === 'timesheet_approval' && link.entity_id) {
        const approvalRes = await supabase
          .from('timesheet_approvals')
          .select('department_id')
          .eq('id', link.entity_id)
          .maybeSingle();
        if (approvalRes.error) throw approvalRes.error;
        const deptId = approvalRes.data ? String(approvalRes.data.department_id) : null;
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

    const downloadUrl = await r2Service.generateDownloadUrl(doc.r2_key);
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

    const { data: request, error: reqErr } = await supabase
      .from('leave_requests')
      .select('id, employee_id')
      .eq('id', leaveRequestId)
      .single();
    if (reqErr || !request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, request.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }

    const { data: links, error: linksError } = await supabase
      .from('document_links')
      .select('document_id')
      .eq('entity_type', 'leave_request')
      .eq('entity_id', String(leaveRequestId));
    if (linksError) throw linksError;

    const linkedIds = [...new Set((links || []).map(link => Number(link.document_id)).filter(Number.isFinite))];

    const { data: legacyDocs, error: legacyErr } = await supabase
      .from('documents')
      .select(DOCUMENT_SELECT_COLUMNS)
      .eq('leave_request_id', leaveRequestId)
      .order('created_at', { ascending: false });
    if (legacyErr) throw legacyErr;

    const docIds = new Set<number>(linkedIds);
    for (const doc of legacyDocs || []) docIds.add(Number(doc.id));

    if (docIds.size === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('documents')
      .select(DOCUMENT_SELECT_COLUMNS)
      .in('id', [...docIds])
      .order('created_at', { ascending: false });
    if (error) throw error;

    res.json({ success: true, data: data || [] });
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

    const { data: doc, error: fetchErr } = await supabase
      .from('documents')
      .select('r2_key, employee_id')
      .eq('id', id)
      .single();

    if (fetchErr || !doc) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, doc.employee_id))) {
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

    const { error } = await supabase.from('documents').delete().eq('id', id);
    if (error) throw error;

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
