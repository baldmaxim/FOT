import type { Response } from 'express';
import * as Sentry from '@sentry/node';

import { withTransaction } from '../config/postgres.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import {
  COMPENSATION_FILES_MAX,
  countEmployeeCompensationFiles,
  deleteCompensationFile,
  getCompensationFileObject,
  hasCompensation,
  insertCompensationFile,
  listCompensationFiles,
  type ICompensationFile,
} from '../services/dormitory-compensation-files.service.js';
import { lockPayrollEmployee } from '../services/payroll/payroll-terms.service.js';
import { r2Service } from '../services/r2.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';
import { SCHEDULE_FILE_TYPES_HINT, detectScheduleFileType, scheduleFileName } from '../utils/schedule-file-type.js';
import { canWriteStay, rosterEmployeeIds } from './dormitory-access.js';

// «Компенсация аренды» → файлы сотрудника (миграция 380): список, ссылка по клику, загрузка, удаление. Права страницы
// проверяет роутер (просмотр — view, загрузка и удаление — edit «Проживания»); здесь — охват сотрудника (как список
// компенсации: rosterEmployeeIds, запись — canWriteStay), есть ли у него компенсация, предел и хранилище. Образец —
// файлы шаблонов графиков (schedule-files.controller.ts, 376).

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

const ENTITY_TYPE = 'employee';
const FILE_URL_TTL_SECONDS = 300;

const BAD_EMPLOYEE = { success: false, error: 'Некорректный сотрудник' };
const BAD_FILE_ID = { success: false, error: 'Некорректный файл' };
const NOT_FOUND = { success: false, error: 'У сотрудника нет компенсации аренды' };
const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const FILE_NOT_FOUND = { success: false, error: 'Файл не найден' };
const NO_STORAGE = { success: false, error: 'Хранилище файлов не настроено' };
const FILES_LIMIT = {
  success: false,
  error: `У сотрудника не больше ${COMPENSATION_FILES_MAX} файлов компенсации`,
  code: 'COMPENSATION_FILES_LIMIT',
};

const parsePositiveId = (raw: unknown): number | null => {
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
    console.warn('[compensation-files] объект R2 не удалён:', key, error);
    Sentry.captureException(error, { tags: { area: 'dormitory-compensation-files' }, extra: { key } });
  }
};

type Access = { ok: true; employeeId: number } | { ok: false; status: number; body: Record<string, unknown> };

/** Сотрудник из адреса: в охвате (просмотр — список кадров, запись — canWriteStay) и с компенсацией аренды. */
const resolveEmployee = async (req: AuthenticatedRequest, mode: 'view' | 'edit'): Promise<Access> => {
  const employeeId = parsePositiveId(req.params.employeeId);
  if (employeeId === null) return { ok: false, status: 400, body: BAD_EMPLOYEE };
  if (mode === 'view') {
    const roster = await rosterEmployeeIds(req);
    if (roster !== null && !roster.includes(employeeId)) return { ok: false, status: 403, body: NO_ACCESS };
  } else if (!(await canWriteStay(req, employeeId))) {
    return { ok: false, status: 403, body: NO_ACCESS };
  }
  if (!(await hasCompensation(employeeId))) return { ok: false, status: 404, body: NOT_FOUND };
  return { ok: true, employeeId };
};

/** GET /api/dormitory/compensation/:employeeId/files — файлы (без ссылок), по порядку прикрепления. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const access = await resolveEmployee(req, 'view');
    if (!access.ok) {
      res.status(access.status).json(access.body);
      return;
    }
    res.json({ success: true, data: await listCompensationFiles(access.employeeId) });
  } catch (err) {
    console.error('[compensation-files] list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения файлов' });
  }
};

/** GET /api/dormitory/compensation/:employeeId/files/:fileId/url?disposition=inline|attachment — ссылка на 5 минут. */
const fileUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const fileId = parsePositiveId(req.params.fileId);
    const disposition = parseDisposition(req.query.disposition);
    if (fileId === null || disposition === null) {
      res.status(400).json(BAD_FILE_ID);
      return;
    }
    const access = await resolveEmployee(req, 'view');
    if (!access.ok) {
      res.status(access.status).json(access.body);
      return;
    }
    const file = await getCompensationFileObject(access.employeeId, fileId);
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
    console.error('[compensation-files] url error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения файла' });
  }
};

type UploadOutcome =
  | { ok: true; file: ICompensationFile }
  | { ok: false; status: number; body: Record<string, unknown> };

/** POST /api/dormitory/compensation/:employeeId/files (multipart `file`) — прикрепить один файл. */
const upload = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    const access = await resolveEmployee(req, 'edit');
    if (!access.ok) {
      res.status(access.status).json(access.body);
      return;
    }
    const { employeeId } = access;
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

    const fileName = scheduleFileName(decodedName, type.ext);
    const r2Key = r2Service.generateCompensationFileKey(employeeId, type.ext);
    try {
      await r2Service.uploadObject(r2Key, file.buffer, type.mime);
    } catch (uploadErr) {
      console.error('[compensation-files] загрузка в R2 не удалась:', uploadErr);
      res.status(502).json({ success: false, error: `Не удалось сохранить файл «${fileName}» — попробуйте ещё раз` });
      return;
    }

    let outcome: UploadOutcome;
    try {
      outcome = await withTransaction(async (client): Promise<UploadOutcome> => {
        // Под замком сотрудника: параллельные загрузки не обгонят предел.
        await lockPayrollEmployee(client, employeeId);
        if (!(await hasCompensation(employeeId, client))) return { ok: false, status: 404, body: NOT_FOUND };
        if ((await countEmployeeCompensationFiles(client, employeeId)) >= COMPENSATION_FILES_MAX) {
          return { ok: false, status: 409, body: FILES_LIMIT };
        }
        const created = await insertCompensationFile(client, {
          employeeId,
          r2Key,
          fileName,
          fileSize: file.size,
          mimeType: type.mime,
        });
        await auditService.logFromRequestWithClient(
          client, req, req.user.id, AUDIT_ACTIONS.DORMITORY_COMPENSATION_FILE_UPLOADED, {
            entityType: ENTITY_TYPE,
            entityId: String(employeeId),
            details: { file_id: created.id, file_name: created.file_name, file_size: created.file_size, mime_type: created.mime_type },
          },
        );
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
    console.error('[compensation-files] upload error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки файла' });
  }
};

type RemoveOutcome =
  | { ok: true; r2Key: string }
  | { ok: false; status: number; body: Record<string, unknown> };

/** DELETE /api/dormitory/compensation/:employeeId/files/:fileId — удалить файл; объект R2 — после коммита. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const fileId = parsePositiveId(req.params.fileId);
    if (fileId === null) {
      res.status(400).json(BAD_FILE_ID);
      return;
    }
    const access = await resolveEmployee(req, 'edit');
    if (!access.ok) {
      res.status(access.status).json(access.body);
      return;
    }
    const { employeeId } = access;
    const outcome = await withTransaction(async (client): Promise<RemoveOutcome> => {
      await lockPayrollEmployee(client, employeeId);
      const deleted = await deleteCompensationFile(client, employeeId, fileId);
      if (!deleted) return { ok: false, status: 404, body: FILE_NOT_FOUND };
      await auditService.logFromRequestWithClient(
        client, req, req.user.id, AUDIT_ACTIONS.DORMITORY_COMPENSATION_FILE_DELETED, {
          entityType: ENTITY_TYPE,
          entityId: String(employeeId),
          details: { file_id: fileId, file_name: deleted.fileName },
        },
      );
      return { ok: true, r2Key: deleted.r2Key };
    });
    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.body);
      return;
    }
    await deleteObjectBestEffort(outcome.r2Key);
    res.json({ success: true });
  } catch (err) {
    console.error('[compensation-files] remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления файла' });
  }
};

export const dormitoryCompensationFilesController = {
  list,
  fileUrl,
  upload,
  remove,
};
