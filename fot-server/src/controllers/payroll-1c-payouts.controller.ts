/**
 * «Перечислено (1С)» (миграция 328): загрузка ведомостей выплаты из 1С и история сотрудника. Справочно — в расчётах
 * ФОТ не участвует. Право загрузки — canImportPayouts1c (его же видит кнопка). Содержимое файла в логи не пишется.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { canImportPayouts1c } from '../services/payroll/payroll-1c-payouts.access.js';
import { Payout1cParseError } from '../services/payroll/payroll-1c-payouts.parser.js';
import {
  importPayouts1c,
  listEmployeePayouts1c,
  listPayouts1cMonths,
  Payout1cImportError,
  previewPayouts1c,
} from '../services/payroll/payroll-1c-payouts.service.js';
import { resolvePayrollStaffScope } from '../services/payroll/payroll-registry-scope.service.js';
import { canReadPayrollEmployee } from '../services/payroll/payroll-scope.service.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается месяц YYYY-MM');
const rangeQuerySchema = z.object({ from: monthSchema, to: monthSchema })
  .refine(range => range.from <= range.to, 'Начало периода позже конца');

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Некорректный хеш');
const importBodySchema = z.object({
  incoming_content_hash: sha256Schema,
  expected_revision: z.coerce.number().int().min(0),
  confirm_replace: z.enum(['true', 'false']).default('false'),
  choices: z.string().max(200_000).default('{}'),
});
const choicesSchema = z.record(sha256Schema, z.number().int().positive().nullable());

const sendError = (res: Response, err: unknown, label: string): void => {
  if (err instanceof Payout1cParseError) {
    res.status(400).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof Payout1cImportError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
    return;
  }
  // Только тип ошибки: в сообщениях pg бывают значения из файла.
  console.error(`payroll1cPayouts.${label} error:`, err instanceof Error ? err.name : 'unknown');
  res.status(500).json({ success: false, error: 'Ошибка загрузки ведомости из 1С' });
};

/** GET /api/payroll/1c-payouts/capability — видна ли кнопка «Загрузить из 1С». */
const capability = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: { can_import: await canImportPayouts1c(req) } });
  } catch (err) {
    sendError(res, err, 'capability');
  }
};

/** POST /api/payroll/1c-payouts/preview (multipart, file) — разбор и сопоставление, без записи. */
const preview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await previewPayouts1c((req.file as Express.Multer.File).buffer) });
  } catch (err) {
    sendError(res, err, 'preview');
  }
};

/**
 * POST /api/payroll/1c-payouts/import (multipart: file, incoming_content_hash, expected_revision, confirm_replace,
 * choices — JSON «fingerprint → id сотрудника | null»).
 */
const importFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const body = importBodySchema.parse(req.body ?? {});
    let rawChoices: unknown;
    try {
      rawChoices = JSON.parse(body.choices);
    } catch {
      res.status(400).json({ success: false, error: 'Некорректный выбор сотрудников' });
      return;
    }
    const file = req.file as Express.Multer.File;
    const result = await importPayouts1c({
      buffer: file.buffer,
      fileName: decodeMulterFilename(file.originalname),
      userId: req.user.id ?? null,
      incomingContentHash: body.incoming_content_hash,
      expectedRevision: body.expected_revision,
      confirmReplace: body.confirm_replace === 'true',
      choices: choicesSchema.parse(rawChoices),
    });
    if (result.action !== 'unchanged' && result.document_id !== null) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_1C_PAYOUTS_IMPORTED', {
        entityType: 'payroll_1c_payout_document',
        entityId: String(result.document_id),
        details: {
          action: result.action,
          revision: result.revision,
          lines_matched: result.lines_matched,
          lines_unmatched: result.lines_unmatched,
        },
      });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, err, 'import');
  }
};

/** GET /api/payroll/terms/employee/:empId/payouts-1c?from=YYYY-MM&to=YYYY-MM — перечисленное по месяцам начисления. */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const range = rangeQuerySchema.parse(req.query);
    res.json({ success: true, data: await listEmployeePayouts1c(employeeId, range.from, range.to) });
  } catch (err) {
    sendError(res, err, 'getByEmployee');
  }
};

/** GET /api/payroll/1c-payouts/months — месяцы ведомостей в банк у штата в охвате (выбор месяцев «Расчётов»). */
const months = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listPayouts1cMonths(await resolvePayrollStaffScope(req)) });
  } catch (err) {
    sendError(res, err, 'months');
  }
};

export const payroll1cPayoutsController = { capability, preview, importFile, getByEmployee, months };
