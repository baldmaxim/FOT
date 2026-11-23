import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { withTransaction } from '../config/postgres.js';
import { r2Service } from '../services/r2.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import {
  SCHEDULE_FILES_MAX,
  countScheduleFiles,
  deleteScheduleFile,
  getScheduleFileObject,
  getScheduleFilesTarget,
  insertScheduleFile,
  listScheduleFiles,
  lockScheduleForFiles,
  type IScheduleFile,
} from '../services/schedule-files.service.js';
import { SCHEDULE_FILE_TYPES_HINT, detectScheduleFileType, scheduleFileName } from '../utils/schedule-file-type.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

// Файлы шаблона графика работы (миграция 376): список, ссылка по клику, загрузка, удаление.
// Права проверяет роутер (как у CRUD шаблонов); здесь — график, архив, предел и хранилище.

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

const ENTITY_TYPE = 'work_schedule';
const FILE_URL_TTL_SECONDS = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BAD_SCHEDULE = { success: false, error: 'Некорректный график' };
const BAD_FILE_ID = { success: false, error: 'Некорректный файл' };
const NOT_FOUND = { success: false, error: 'График не найден' };
const FILE_NOT_FOUND = { success: false, error: 'Файл не найден' };
const ARCHIVED = { success: false, error: 'График в архиве — файлы не меняются' };
const NO_STORAGE = { success: false, error: 'Хранилище файлов не настроено' };
const FILES_LIMIT = {
  success: false,
  error: `У графика не больше ${SCHEDULE_FILES_MAX} файлов`,
  code: 'SCHEDULE_FILES_LIMIT',
};

const parseScheduleId = (raw: unknown): string | null =>
  typeof raw === 'string' && UUID_RE.test(raw) ? raw.toLowerCase() : null;

const parseFileId = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0 ? value : null;
};

const parseDisposition = (raw: unknown): 'inline' | 'attachment' | null => {
  if (raw === undefined) return 'attachment';
  return raw === 'inline' || raw === 'attachment' ? raw : null;
};

/** Удалить объект R2 best-effort: сбой — в лог и Sentry, объект остаётся сиротой. */
const deleteObjectBestEffort = async (key: string): Promise<void> => {
  try {
    await r2Service.deleteObject(key);
  } catch (error) {
    console.warn('[schedule-files] объект R2 не удалён:', key, error);
    Sentry.captureException(error, { tags: { area: 'work-schedule-files' }, extra: { key } });
  }
};

/** GET /api/schedules/:id/files — файлы графика (без ссылок), по порядку прикрепления. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scheduleId = parseScheduleId(req.params.id);
    if (!scheduleId) {
      res.status(400).json(BAD_SCHEDULE);
      return;
    }
    if ((await getScheduleFilesTarget(scheduleId)) === 'missing') {
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.json({ success: true, data: await listScheduleFiles(scheduleId) });
  } catch (err) {
    console.error('[schedule-files] list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения файлов графика' });
  }
};

/** GET /api/schedules/:id/files/:fileId/url?disposition=inline|attachment — ссылка на 5 минут по клику. */
const fileUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scheduleId = parseScheduleId(req.params.id);
    if (!scheduleId) {
      res.status(400).json(BAD_SCHEDULE);
      return;
    }
    const fileId = parseFileId(req.params.fileId);
    const disposition = parseDisposition(req.query.disposition);
    if (fileId === null || disposition === null) {
      res.status(400).json(BAD_FILE_ID);
      return;
    }
    if ((await getScheduleFilesTarget(scheduleId)) === 'missing') {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const file = await getScheduleFileObject(scheduleId, fileId);
    if (!file) {
      res.status(404).json(FILE_NOT_FOUND);
      return;
    }
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json(NO_STORAGE);
      return;
    }
    const url = await r2Service.generateDownloadUrl(file.r2_key, file.file_name, disposition, FILE_URL_TTL_SECONDS);
    res.json({ success: true, data: { url } });
  } catch (err) {
    console.error('[schedule-files] url error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения файла' });
  }
};

type UploadOutcome =
  | { ok: true; file: IScheduleFile }
  | { ok: false; status: number; body: Record<string, unknown> };

/** POST /api/schedules/:id/files (multipart `file`) — прикрепить один файл. */
const upload = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    const scheduleId = parseScheduleId(req.params.id);
    if (!scheduleId) {
      res.status(400).json(BAD_SCHEDULE);
      return;
    }
    const file = req.file;
    if (!file || file.size <= 0) {
      res.status(400).json({ success: false, error: 'Файл обязателен' });
      return;
    }
    const decodedName = decodeMulterFilename(file.originalname);
    const type = await detectScheduleFileType(file.buffer, decodedName, file.mimetype);
    if (!type) {
      res.status(400).json({
        success: false,
        error: `Файл «${sanitizeFileName(decodedName, 80)}»: ${SCHEDULE_FILE_TYPES_HINT}`,
      });
      return;
    }
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json(NO_STORAGE);
      return;
    }
    // Предпроверка до R2: в архивный или удалённый график файл не грузим вовсе.
    const target = await getScheduleFilesTarget(scheduleId);
    if (target === 'missing') {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (target === 'archived') {
      res.status(409).json(ARCHIVED);
      return;
    }

    const fileName = scheduleFileName(decodedName, type.ext);
    const r2Key = r2Service.generateWorkScheduleKey(scheduleId, type.ext);
    try {
      await r2Service.uploadObject(r2Key, file.buffer, type.mime);
    } catch (uploadErr) {
      console.error('[schedule-files] загрузка в R2 не удалась:', uploadErr);
      res.status(502).json({ success: false, error: `Не удалось сохранить файл «${fileName}» — попробуйте ещё раз` });
      return;
    }

    let outcome: UploadOutcome;
    try {
      outcome = await withTransaction(async (client): Promise<UploadOutcome> => {
        // Повторная проверка под блокировкой: архивация или параллельная загрузка могли успеть.
        const locked = await lockScheduleForFiles(client, scheduleId);
        if (locked === 'missing') return { ok: false, status: 404, body: NOT_FOUND };
        if (locked === 'archived') return { ok: false, status: 409, body: ARCHIVED };
        if ((await countScheduleFiles(client, scheduleId)) >= SCHEDULE_FILES_MAX) {
          return { ok: false, status: 409, body: FILES_LIMIT };
        }
        const created = await insertScheduleFile(client, {
          scheduleId,
          r2Key,
          fileName,
          fileSize: file.size,
          mimeType: type.mime,
        });
        await auditService.logFromRequestWithClient(client, req, req.user.id, AUDIT_ACTIONS.WORK_SCHEDULE_FILE_UPLOADED, {
          entityType: ENTITY_TYPE,
          entityId: scheduleId,
          details: { file_id: created.id, file_name: created.file_name, file_size: created.file_size, mime_type: created.mime_type },
        });
        return { ok: true, file: created };
      });
    } catch (txErr) {
      await deleteObjectBestEffort(r2Key);
      throw txErr;
    }

    if (!outcome.ok) {
      await deleteObjectBestEffort(r2Key);
      res.status(outcome.status).json(outcome.body);
      return;
    }
    res.json({ success: true, data: outcome.file });
  } catch (err) {
    console.error('[schedule-files] upload error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки файла' });
  }
};

type RemoveOutcome =
  | { ok: true; r2Key: string }
  | { ok: false; status: number; body: Record<string, unknown> };

/** DELETE /api/schedules/:id/files/:fileId — удалить файл; объект R2 — после коммита. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scheduleId = parseScheduleId(req.params.id);
    if (!scheduleId) {
      res.status(400).json(BAD_SCHEDULE);
      return;
    }
    const fileId = parseFileId(req.params.fileId);
    if (fileId === null) {
      res.status(400).json(BAD_FILE_ID);
      return;
    }

    const outcome = await withTransaction(async (client): Promise<RemoveOutcome> => {
      const locked = await lockScheduleForFiles(client, scheduleId);
      if (locked === 'missing') return { ok: false, status: 404, body: NOT_FOUND };
      if (locked === 'archived') return { ok: false, status: 409, body: ARCHIVED };
      const deleted = await deleteScheduleFile(client, scheduleId, fileId);
      if (!deleted) return { ok: false, status: 404, body: FILE_NOT_FOUND };
      await auditService.logFromRequestWithClient(client, req, req.user.id, AUDIT_ACTIONS.WORK_SCHEDULE_FILE_DELETED, {
        entityType: ENTITY_TYPE,
        entityId: scheduleId,
        details: { file_id: fileId, file_name: deleted.fileName },
      });
      return { ok: true, r2Key: deleted.r2Key };
    });

    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.body);
      return;
    }
    await deleteObjectBestEffort(outcome.r2Key);
    res.json({ success: true });
  } catch (err) {
    console.error('[schedule-files] remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления файла' });
  }
};

export const scheduleFilesController = {
  list,
  fileUrl,
  upload,
  remove,
};
