/**
 * Сканы кадрового профиля — отдельный API (не общий /documents): категории только
 * hr_*, владелец — сотрудник в скоупе либо свой черновик, выдача файла только
 * backend-stream с расшифровкой, аудит просмотра/скачивания/удаления.
 */
import type { Response } from 'express';
import { execute } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';
import { auditService } from '../services/audit.service.js';
import { isHrCryptoConfigured } from '../services/hr-crypto.service.js';
import {
  HrDocumentError,
  countCompleteness,
  groupIntoSlots,
  listDraftHrDocumentRows,
  listEmployeeHrDocumentRows,
  loadDecryptedBytes,
  loadHrDocument,
  resolveHrDocumentOwner,
  softDeleteHrDocument,
  toPublic,
  uploadHrDocument,
  type IHrDocumentRow,
} from '../services/hr-documents.service.js';
import { loadDraft } from '../services/hr-draft.service.js';
import { buildProfileView, loadProfileRow } from '../services/hr-profile.service.js';
import { enqueueHrOcr } from '../services/hr-ocr/worker.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';
import { resolveDocumentSlots } from '../config/hr-documents.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

const ensureConfigured = (res: Response): boolean => {
  if (!isHrCryptoConfigured()) {
    res.status(503).json({ success: false, error: 'Кадровый модуль не настроен (ключи шифрования)', code: 'HR_NOT_CONFIGURED' });
    return false;
  }
  return true;
};

const handleError = (res: Response, err: unknown, fallback: string): void => {
  if (err instanceof HrDocumentError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }
  console.error(`[hr-documents] ${fallback}:`, err instanceof Error ? err.message : err);
  res.status(500).json({ success: false, error: fallback });
};

/** Доступ к документу: сотрудник в скоупе или свой черновик. */
const authorizeDocument = async (req: AuthenticatedRequest, doc: IHrDocumentRow): Promise<boolean> => {
  if (doc.employee_id) return canAccessEmployeeInScope(req, doc.employee_id);
  const owner = await resolveHrDocumentOwner(doc.id);
  if (owner.employeeId) return canAccessEmployeeInScope(req, owner.employeeId);
  if (owner.draftId) {
    const draft = await loadDraft(owner.draftId);
    return !!draft && draft.created_by === req.user.id;
  }
  return false;
};

const uploadForEmployee = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = Number(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const profile = await loadProfileRow(employeeId);
    if (!profile) {
      res.status(404).json({ success: false, error: 'Сначала заведите реквизиты сотрудника' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Файл обязателен' });
      return;
    }
    const row = await uploadHrDocument({ employeeId }, {
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      originalName: decodeMulterFilename(req.file.originalname),
      typeCode: String(req.body.type || ''),
      uploadedBy: req.user.id,
      passportType: profile.passport_type,
    });
    await auditService.logFromRequest(req, req.user.id, 'HR_FILE_UPLOAD', {
      entityType: 'document', entityId: String(row.id), details: { employee_id: employeeId, category: row.category },
    });
    res.status(201).json({ success: true, data: toPublic(row) });
  } catch (err) {
    handleError(res, err, 'Ошибка загрузки документа');
  }
};

const uploadForDraft = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const draft = await loadDraft(String(req.params.draftId));
    if (!draft || draft.created_by !== req.user.id) {
      res.status(404).json({ success: false, error: 'Черновик не найден' });
      return;
    }
    if (draft.state !== 'draft') {
      res.status(409).json({ success: false, error: draft.state === 'attached' ? 'Черновик уже завершён' : 'Сотрудник уже создан — документы прикрепляются к его карточке' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Файл обязателен' });
      return;
    }
    const passportType = (req.body.passport_type === 'foreign' || req.body.passport_type === 'russian') ? req.body.passport_type : null;
    const row = await uploadHrDocument({ draftId: draft.id }, {
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      originalName: decodeMulterFilename(req.file.originalname),
      typeCode: String(req.body.type || ''),
      uploadedBy: req.user.id,
      passportType,
    });
    await auditService.logFromRequest(req, req.user.id, 'HR_FILE_UPLOAD', {
      entityType: 'document', entityId: String(row.id), details: { draft_id: draft.id, category: row.category },
    });
    res.status(201).json({ success: true, data: toPublic(row) });
  } catch (err) {
    handleError(res, err, 'Ошибка загрузки документа');
  }
};

const listForEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = Number(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const profileRow = await loadProfileRow(employeeId);
    const rows = await listEmployeeHrDocumentRows(employeeId);
    const view = profileRow ? await buildProfileView(profileRow, { unmask: false }) : null;
    const slots = view ? view.document_slots : resolveDocumentSlots('ru', false);
    res.json({
      success: true,
      data: {
        slots: groupIntoSlots(rows, slots),
        completeness: countCompleteness(rows, slots),
      },
    });
  } catch (err) {
    handleError(res, err, 'Ошибка получения документов');
  }
};

const listForDraft = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const draft = await loadDraft(String(req.params.draftId));
    if (!draft || draft.created_by !== req.user.id) {
      res.status(404).json({ success: false, error: 'Черновик не найден' });
      return;
    }
    const rows = await listDraftHrDocumentRows(draft.id);
    res.json({ success: true, data: rows.map(toPublic) });
  } catch (err) {
    handleError(res, err, 'Ошибка получения документов');
  }
};

/** Backend-stream расшифрованного файла (inline для просмотра / attachment для скачивания). */
const content = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const doc = await loadHrDocument(Number(req.params.id));
    if (!doc || doc.deleted_at) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }
    if (!(await authorizeDocument(req, doc))) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }
    const disposition = req.query.disposition === 'attachment' ? 'attachment' : 'inline';
    const bytes = await loadDecryptedBytes(doc);
    await auditService.logFromRequest(req, req.user.id, disposition === 'attachment' ? 'HR_FILE_DOWNLOAD' : 'HR_FILE_VIEW', {
      entityType: 'document', entityId: String(doc.id), details: { employee_id: doc.employee_id, category: doc.category },
    });
    const encodedName = encodeURIComponent(doc.file_name).replace(/'/g, '%27');
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${disposition}; filename="file"; filename*=UTF-8''${encodedName}`);
    res.end(bytes);
  } catch (err) {
    handleError(res, err, 'Ошибка получения файла');
  }
};

const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const doc = await loadHrDocument(Number(req.params.id));
    if (!doc || doc.deleted_at) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }
    if (!(await authorizeDocument(req, doc))) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }
    await softDeleteHrDocument(doc, { userId: req.user.id });
    await auditService.logFromRequest(req, req.user.id, 'HR_FILE_DELETE', {
      entityType: 'document', entityId: String(doc.id), details: { employee_id: doc.employee_id, category: doc.category },
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Ошибка удаления документа');
  }
};

const recognize = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const doc = await loadHrDocument(Number(req.params.id));
    if (!doc || doc.deleted_at) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }
    if (!(await authorizeDocument(req, doc))) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }
    if (!toPublic(doc).ocr_supported) {
      res.status(400).json({ success: false, error: 'Этот тип документа не распознаётся' });
      return;
    }
    await enqueueHrOcr(doc.id);
    await execute(`UPDATE documents SET recognition_error = NULL WHERE id = $1`, [doc.id]);
    await auditService.logFromRequest(req, req.user.id, 'HR_OCR_RUN', {
      entityType: 'document', entityId: String(doc.id), details: { employee_id: doc.employee_id, category: doc.category },
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'Ошибка постановки в очередь распознавания');
  }
};

export const hrDocumentsController = {
  uploadForEmployee,
  uploadForDraft,
  listForEmployee,
  listForDraft,
  content,
  remove,
  recognize,
};
