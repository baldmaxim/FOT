/**
 * «Доплата» → разовая доплата (миграция 315) и её файлы (миграция 354): месяц, сумма, основание; вносится
 * только в «Справочнике». Файлы приходят с сохранением доплаты одним multipart-запросом (поле data — JSON
 * полей, files — файлы), снятие — remove_file_ids. Доплата, строки файлов и аудит — одной транзакцией;
 * объекты R2 — до неё (откат — удаление загруженного) и после коммита (снятые, best-effort). Ссылку на файл
 * выдаёт отдельный GET по клику.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { r2Service } from '../services/r2.service.js';
import {
  canWritePayrollRegistryEmployee,
  isPayrollStaffEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import {
  deleteSupplementObjects,
  prepareSupplementFiles,
  SupplementFileUploadError,
  uploadSupplementFiles,
  type IPreparedSupplementFile,
} from '../services/payroll/payroll-supplement-files.js';
import {
  addOneTimeSupplement,
  deleteOneTimeSupplement,
  getOneTimeSupplement,
  getOneTimeSupplementFile,
  ONE_TIME_SUPPLEMENT_FILES_MAX,
  updateOneTimeSupplement,
  type INewOneTimeSupplementFile,
  type IOneTimeSupplement,
} from '../services/payroll/payroll-supplements.service.js';
import {
  handlePayrollZodError,
  parsePayrollDictionaryId,
  payrollEmployeeIdSchema,
  payrollMonthSchema,
  payrollPositiveMoneySchema,
} from './payroll-dictionary.helpers.js';

const oneTimeFields = {
  month: payrollMonthSchema('Укажите месяц'),
  amount: payrollPositiveMoneySchema('Укажите сумму доплаты'),
  reason: z.string({ required_error: 'Укажите основание', invalid_type_error: 'Укажите основание' })
    .transform(value => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'Укажите основание').max(200, 'Основание — не больше 200 символов')),
};
const oneTimeAddSchema = z.object({ employee_id: payrollEmployeeIdSchema, ...oneTimeFields });
// Правка: те же поля и необязательные id снимаемых файлов (прежний клиент их не шлёт).
const oneTimeUpdateSchema = z.object({
  ...oneTimeFields,
  remove_file_ids: z.array(
    z.number({ invalid_type_error: 'Некорректный файл' }).int('Некорректный файл').positive('Некорректный файл'),
    { invalid_type_error: 'Некорректный список файлов' },
  )
    .max(ONE_TIME_SUPPLEMENT_FILES_MAX, 'Не больше 10 файлов')
    .refine(ids => new Set(ids).size === ids.length, 'Файл указан дважды')
    .optional()
    .default([]),
});
const fileUrlQuerySchema = z.object({
  disposition: z.enum(['inline', 'attachment'], { invalid_type_error: 'Некорректный вид ссылки' }).default('attachment'),
});
/** Ссылка на файл доплаты живёт 5 минут: открывается без авторизации, пока не истекла. */
const FILE_URL_TTL_SECONDS = 300;

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NOT_FOUND = { success: false, error: 'Доплата не найдена' };
const STALE = {
  success: false,
  error: 'Доплата уже изменилась — обновите таблицу',
  code: 'SUPPLEMENT_STALE',
};
const FORM_ERROR = { success: false, error: 'Некорректные данные формы' };
const FILES_LIMIT = { success: false, error: 'Не больше 10 файлов', code: 'SUPPLEMENT_FILES_LIMIT' };
const NO_STORAGE = { success: false, error: 'Хранилище файлов не настроено' };
const FILE_NOT_FOUND = { success: false, error: 'Файл не найден' };

const oneTimeAudit = (row: IOneTimeSupplement) => ({
  employee_id: row.employee_id,
  full_name: row.full_name,
  month: row.month,
  amount: row.amount,
  reason: row.reason,
});

const filesAudit = (files: ReadonlyArray<{ file_name: string; file_size: number }>) => (
  files.map(file => ({ file_name: file.file_name, file_size: file.file_size }))
);

export interface ISupplementFilesRequest extends AuthenticatedRequest {
  files?: Express.Multer.File[] | Record<string, Express.Multer.File[]>;
}

const BAD_FORM = Symbol('bad-form');

/**
 * Тело запроса доплаты: multipart (multer заполнил files массивом) — JSON из поля data, иначе — JSON-тело
 * как есть. data нет или это не JSON-объект — BAD_FORM.
 */
const readOneTimeBody = (req: ISupplementFilesRequest): unknown => {
  if (!Array.isArray(req.files)) return req.body;
  const raw: unknown = (req.body as Record<string, unknown> | undefined)?.data;
  if (typeof raw !== 'string') return BAD_FORM;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : BAD_FORM;
  } catch {
    return BAD_FORM;
  }
};

const requestFiles = (req: ISupplementFilesRequest): Express.Multer.File[] => (Array.isArray(req.files) ? req.files : []);

/**
 * Проверить файлы и загрузить их в R2. Ответ уже отправлен — null (тип, хранилище выключено); файлов нет — [].
 */
const uploadRequestFiles = async (
  res: Response,
  employeeId: number,
  prepared: IPreparedSupplementFile[],
): Promise<INewOneTimeSupplementFile[] | null> => {
  if (prepared.length === 0) return [];
  if (!(await r2Service.isEnabledAsync())) {
    res.status(503).json(NO_STORAGE);
    return null;
  }
  return uploadSupplementFiles(employeeId, prepared);
};

const handleUploadError = (err: unknown, res: Response): boolean => {
  if (!(err instanceof SupplementFileUploadError)) return false;
  console.error('payrollSupplements: загрузка файла в R2 не удалась:', err.cause ?? err);
  res.status(502).json({ success: false, error: `${err.message} — попробуйте ещё раз` });
  return true;
};

/**
 * POST /api/payroll/supplements/one-time — разовая доплата. JSON { employee_id, month, amount, reason } или
 * multipart: data — тот же JSON, files — до 10 файлов. Доплата, файлы и аудит — одной транзакцией.
 */
const addOneTime = async (req: ISupplementFilesRequest, res: Response): Promise<void> => {
  try {
    const body = readOneTimeBody(req);
    if (body === BAD_FORM) {
      res.status(400).json(FORM_ERROR);
      return;
    }
    const { employee_id: employeeId, ...input } = oneTimeAddSchema.parse(body);
    if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const prepared = prepareSupplementFiles(requestFiles(req));
    if (!prepared.ok) {
      res.status(400).json({ success: false, error: prepared.error });
      return;
    }
    const uploaded = await uploadRequestFiles(res, employeeId, prepared.files);
    if (!uploaded) return;
    let created: IOneTimeSupplement;
    try {
      created = await addOneTimeSupplement(employeeId, input, {
        files: uploaded,
        audit: (client, row) => auditService.logFromRequestWithClient(
          client, req, req.user.id, 'PAYROLL_ONE_TIME_SUPPLEMENT_ADDED', {
            entityType: 'payroll_one_time_supplements',
            entityId: String(row.id),
            details: { ...oneTimeAudit(row), files: filesAudit(row.files) },
          },
        ),
      });
    } catch (err) {
      await deleteSupplementObjects(uploaded.map(file => file.r2Key));
      throw err;
    }
    res.json({ success: true, data: created });
  } catch (err) {
    if (handlePayrollZodError(err, res) || handleUploadError(err, res)) return;
    console.error('payrollSupplements.addOneTime error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления доплаты' });
  }
};

/**
 * PATCH /api/payroll/supplements/one-time/:id { month, amount, reason, remove_file_ids? } — сотрудник не
 * меняется. Новые файлы — multipart (data + files). Снятые файлы удаляются из R2 после коммита.
 */
const updateOneTime = async (req: ISupplementFilesRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getOneTimeSupplement(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const body = readOneTimeBody(req);
    if (body === BAD_FORM) {
      res.status(400).json(FORM_ERROR);
      return;
    }
    const { remove_file_ids: removeFileIds, ...input } = oneTimeUpdateSchema.parse(body);
    if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const prepared = prepareSupplementFiles(requestFiles(req));
    if (!prepared.ok) {
      res.status(400).json({ success: false, error: prepared.error });
      return;
    }
    // Заведомо больше 10 — до загрузки в R2; под блокировкой доплаты сервис проверит ещё раз.
    if (current.files.length - removeFileIds.length + prepared.files.length > ONE_TIME_SUPPLEMENT_FILES_MAX) {
      res.status(400).json(FILES_LIMIT);
      return;
    }
    const uploaded = await uploadRequestFiles(res, current.employee_id, prepared.files);
    if (!uploaded) return;
    const uploadedKeys = uploaded.map(file => file.r2Key);
    let result: Awaited<ReturnType<typeof updateOneTimeSupplement>>;
    try {
      result = await updateOneTimeSupplement(id, input, {
        addFiles: uploaded,
        removeFileIds,
        audit: (client, before, after) => {
          const kept = new Set(after.files.map(file => file.id));
          const was = new Set(before.files.map(file => file.id));
          const removed = before.files.filter(file => !kept.has(file.id));
          const added = after.files.filter(file => !was.has(file.id));
          return auditService.logFromRequestWithClient(
            client, req, req.user.id, 'PAYROLL_ONE_TIME_SUPPLEMENT_UPDATED', {
              entityType: 'payroll_one_time_supplements',
              entityId: String(id),
              details: {
                from: oneTimeAudit(before),
                to: oneTimeAudit(after),
                ...(added.length > 0 ? { files_added: filesAudit(added) } : {}),
                ...(removed.length > 0 ? { files_removed: filesAudit(removed) } : {}),
              },
            },
          );
        },
      });
    } catch (err) {
      await deleteSupplementObjects(uploadedKeys);
      throw err;
    }
    if (result.status !== 'saved') {
      await deleteSupplementObjects(uploadedKeys);
      if (result.status === 'not_found') res.status(404).json(NOT_FOUND);
      else if (result.status === 'stale') res.status(409).json(STALE);
      else res.status(400).json(FILES_LIMIT);
      return;
    }
    await deleteSupplementObjects(result.removedKeys);
    res.json({ success: true, data: result.after });
  } catch (err) {
    if (handlePayrollZodError(err, res) || handleUploadError(err, res)) return;
    console.error('payrollSupplements.updateOneTime error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доплаты' });
  }
};

/** DELETE /api/payroll/supplements/one-time/:id — удалить разовую доплату с файлами. */
const removeOneTime = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getOneTimeSupplement(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const result = await deleteOneTimeSupplement(id, {
      audit: (client, row) => auditService.logFromRequestWithClient(
        client, req, req.user.id, 'PAYROLL_ONE_TIME_SUPPLEMENT_DELETED', {
          entityType: 'payroll_one_time_supplements',
          entityId: String(id),
          details: { ...oneTimeAudit(row), files: filesAudit(row.files) },
        },
      ),
    });
    if (!result) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await deleteSupplementObjects(result.r2Keys);
    res.json({ success: true, data: result.deleted });
  } catch (err) {
    console.error('payrollSupplements.removeOneTime error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления доплаты' });
  }
};

/**
 * GET /api/payroll/supplements/one-time/:id/files/:fileId/url?disposition=inline|attachment — ссылка на файл
 * (5 минут) по клику. Сотрудник вне охвата «Доплаты» или файл не этой доплаты — 404.
 */
const fileUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const query = fileUrlQuerySchema.parse(req.query);
    const id = parsePayrollDictionaryId(req);
    const fileId = Number(req.params.fileId);
    const file = id !== null && Number.isInteger(fileId) && fileId > 0
      ? await getOneTimeSupplementFile(id, fileId)
      : null;
    if (!file || !(await isPayrollStaffEmployee(file.employee_id, await resolvePayrollStaffScope(req)))) {
      res.status(404).json(FILE_NOT_FOUND);
      return;
    }
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json(NO_STORAGE);
      return;
    }
    const url = await r2Service.generateDownloadUrl(file.r2_key, file.file_name, query.disposition, FILE_URL_TTL_SECONDS);
    res.json({ success: true, data: { url } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSupplements.fileUrl error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения файла' });
  }
};

/** Обработчики разовой доплаты — часть payrollSupplementsController. */
export const oneTimeSupplementHandlers = {
  addOneTime,
  updateOneTime,
  removeOneTime,
  fileUrl,
};
