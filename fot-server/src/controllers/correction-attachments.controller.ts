import type { Response } from 'express';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';
import { r2Service } from '../services/r2.service.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  createCorrectionAttachment,
  deleteCorrectionAttachment,
  listCorrectionAttachments,
  loadCorrectionAdjustmentById,
} from '../services/correction-attachments.service.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIME_EXACT = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

const isMimeAllowed = (mime: string): boolean => {
  if (ALLOWED_MIME_EXACT.has(mime)) return true;
  return ALLOWED_MIME_PREFIXES.some(prefix => mime.startsWith(prefix));
};

const parseAdjustmentId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
};

const ensureAdjustmentAccess = async (
  req: AuthenticatedRequest,
  res: Response,
  adjustmentId: number,
) => {
  const adj = await loadCorrectionAdjustmentById(adjustmentId);
  if (!adj) {
    res.status(404).json({ success: false, error: 'Корректировка не найдена' });
    return null;
  }
  if (!(await canAccessEmployeeInScope(req, adj.employee_id))) {
    res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
    return null;
  }
  return adj;
};

const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const adjustmentId = parseAdjustmentId(req.params.id);
    if (adjustmentId == null) {
      res.status(400).json({ success: false, error: 'Некорректный id корректировки' });
      return;
    }
    const adj = await ensureAdjustmentAccess(req, res, adjustmentId);
    if (!adj) return;

    if (!(await r2Service.isEnabledAsync())) {
      res.json({ success: true, data: [] });
      return;
    }

    const items = await listCorrectionAttachments(adj);
    const data = await Promise.all(items.map(async (item) => ({
      id: item.id,
      source: item.source,
      original_name: item.original_name,
      mime_type: item.mime_type,
      file_size: item.file_size,
      uploaded_at: item.uploaded_at,
      uploader_name: item.uploader_name,
      download_url: await r2Service.generateDownloadUrl(item.r2_key, item.original_name),
      preview_url: await r2Service.generateDownloadUrl(item.r2_key, item.original_name, 'inline'),
    })));
    res.json({ success: true, data });
  } catch (err) {
    console.error('correction-attachments.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения файлов корректировки' });
  }
};

const upload = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'R2 хранилище не настроено' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Файл обязателен' });
      return;
    }

    const adjustmentId = parseAdjustmentId(req.params.id);
    if (adjustmentId == null) {
      res.status(400).json({ success: false, error: 'Некорректный id корректировки' });
      return;
    }
    const adj = await ensureAdjustmentAccess(req, res, adjustmentId);
    if (!adj) return;

    const file = req.file;
    const mimeType = file.mimetype || 'application/octet-stream';
    if (!isMimeAllowed(mimeType)) {
      res.status(400).json({ success: false, error: 'Тип файла не разрешён' });
      return;
    }
    if (file.size <= 0) {
      res.status(400).json({ success: false, error: 'Пустой файл' });
      return;
    }

    const safeFileName = sanitizeFileName(decodeMulterFilename(file.originalname));

    const r2Key = r2Service.generateKey(adj.employee_id, safeFileName);
    await r2Service.uploadObject(r2Key, file.buffer, mimeType);

    let attachment;
    try {
      attachment = await createCorrectionAttachment({
        adjustmentId,
        employeeId: adj.employee_id,
        fileName: safeFileName,
        fileSize: file.size,
        mimeType,
        r2Key,
        uploadedBy: req.user.id,
      });
    } catch (insertErr) {
      try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
      throw insertErr;
    }

    const downloadUrl = await r2Service.generateDownloadUrl(attachment.r2_key, attachment.original_name);
    const previewUrl = await r2Service.generateDownloadUrl(attachment.r2_key, attachment.original_name, 'inline');
    res.json({
      success: true,
      data: {
        id: attachment.id,
        source: attachment.source,
        original_name: attachment.original_name,
        mime_type: attachment.mime_type,
        file_size: attachment.file_size,
        uploaded_at: attachment.uploaded_at,
        uploader_name: attachment.uploader_name,
        download_url: downloadUrl,
        preview_url: previewUrl,
      },
    });
  } catch (err) {
    console.error('correction-attachments.upload error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки файла' });
  }
};

const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const adjustmentId = parseAdjustmentId(req.params.id);
    const documentId = parseAdjustmentId(req.params.attId);
    if (adjustmentId == null || documentId == null) {
      res.status(400).json({ success: false, error: 'Некорректные id' });
      return;
    }
    const adj = await ensureAdjustmentAccess(req, res, adjustmentId);
    if (!adj) return;

    const result = await deleteCorrectionAttachment(adjustmentId, documentId);
    if (!result.owned) {
      res.status(409).json({
        success: false,
        error: 'Файл прикреплён к исходной заявке — удалите его в карточке заявления',
      });
      return;
    }

    if (result.r2Key) {
      try {
        await r2Service.deleteObject(result.r2Key);
      } catch (cleanupErr) {
        console.warn('correction-attachments.remove: r2 delete failed', cleanupErr);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('correction-attachments.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления файла' });
  }
};

export const correctionAttachmentsController = {
  list,
  upload,
  remove,
};
