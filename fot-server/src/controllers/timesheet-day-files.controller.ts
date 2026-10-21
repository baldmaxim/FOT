import type { Response } from 'express';
import { canWriteEmployeeInScope } from '../services/data-scope.service.js';
import { r2Service } from '../services/r2.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';
import { parseIsoDateOnly } from '../utils/date.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  DAY_FILE_ENTITY_TYPE,
  createDayFile,
  dayFileEntityId,
  deleteDayFile,
  employeeExists,
  listDayFiles,
  loadDayFileLink,
  type ITimesheetDayFile,
} from '../services/timesheet-day-files.service.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

// Точный список: картинки без SVG, документы. MIME берётся от клиента (как у вложений корректировок).
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

const parsePositiveInt = (raw: unknown): number | null => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/** Календарно валидная дата YYYY-MM-DD (2026-02-31 → null). */
const parseWorkDate = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return parseIsoDateOnly(value) ? value : null;
};

const toDto = async (file: ITimesheetDayFile) => ({
  id: file.id,
  original_name: file.original_name,
  mime_type: file.mime_type,
  file_size: file.file_size,
  uploaded_at: file.uploaded_at,
  uploader_name: file.uploader_name,
  download_url: await r2Service.generateDownloadUrl(file.r2_key, file.original_name),
  preview_url: await r2Service.generateDownloadUrl(file.r2_key, file.original_name, 'inline'),
});

const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parsePositiveInt(req.query.employee_id);
    const workDate = parseWorkDate(req.query.work_date);
    if (employeeId == null || workDate == null) {
      res.status(400).json({ success: false, error: 'Некорректные сотрудник или дата' });
      return;
    }
    if (!(await canWriteEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    if (!(await r2Service.isEnabledAsync())) {
      res.json({ success: true, data: [] });
      return;
    }
    const files = await listDayFiles(employeeId, workDate);
    res.json({ success: true, data: await Promise.all(files.map(toDto)) });
  } catch (err) {
    console.error('timesheet-day-files.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения файлов дня' });
  }
};

const upload = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const employeeId = parsePositiveInt(body.employee_id);
    const workDate = parseWorkDate(body.work_date);
    if (employeeId == null || workDate == null) {
      res.status(400).json({ success: false, error: 'Некорректные сотрудник или дата' });
      return;
    }
    const file = req.file;
    if (!file || file.size <= 0) {
      res.status(400).json({ success: false, error: 'Файл обязателен' });
      return;
    }
    const mimeType = file.mimetype || 'application/octet-stream';
    if (!ALLOWED_MIME.has(mimeType)) {
      res.status(400).json({ success: false, error: 'Тип файла не разрешён' });
      return;
    }
    if (!(await employeeExists(employeeId))) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if (!(await canWriteEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'R2 хранилище не настроено' });
      return;
    }

    const safeFileName = sanitizeFileName(decodeMulterFilename(file.originalname));
    const r2Key = r2Service.generateKey(employeeId, safeFileName);
    await r2Service.uploadObject(r2Key, file.buffer, mimeType);

    let created: ITimesheetDayFile;
    try {
      created = await createDayFile({
        employeeId,
        workDate,
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

    await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.TIMESHEET_DAY_FILE_UPLOADED, {
      entityType: DAY_FILE_ENTITY_TYPE,
      entityId: dayFileEntityId(employeeId, workDate),
      details: { document_id: created.id, file_name: created.original_name, file_size: created.file_size },
    });

    res.json({ success: true, data: await toDto(created) });
  } catch (err) {
    console.error('timesheet-day-files.upload error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки файла' });
  }
};

const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const documentId = parsePositiveInt(req.params.documentId);
    if (documentId == null) {
      res.status(400).json({ success: false, error: 'Некорректный id файла' });
      return;
    }
    const link = await loadDayFileLink(documentId);
    if (!link) {
      res.status(404).json({ success: false, error: 'Файл не найден' });
      return;
    }
    if (!(await canWriteEmployeeInScope(req, link.employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const result = await deleteDayFile(documentId);
    if (!result.deleted) {
      res.status(409).json({ success: false, error: 'Файл привязан не только к дню — удаление отменено' });
      return;
    }
    if (result.r2Key) {
      try {
        await r2Service.deleteObject(result.r2Key);
      } catch (cleanupErr) {
        console.warn('timesheet-day-files.remove: r2 delete failed', cleanupErr);
      }
    }

    await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.TIMESHEET_DAY_FILE_DELETED, {
      entityType: DAY_FILE_ENTITY_TYPE,
      entityId: dayFileEntityId(link.employeeId, link.workDate),
      details: { document_id: documentId, file_name: result.fileName },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('timesheet-day-files.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления файла' });
  }
};

export const timesheetDayFilesController = {
  list,
  upload,
  remove,
};
