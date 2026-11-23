/**
 * «Проживание» → «Общежитие» → «Справочник» (миграция 377): справочник общежитий — Дата, Номер, Общежитие, Стоимость
 * места (₽, только для информации). Право — вкладки «Проживание» (/staff-control/dormitory): список — view, запись —
 * edit (гарды в dormitory.routes.ts). Без ФИО — виден всем с доступом к вкладке. Переименование меняет название у
 * всех записей общежития; общежитие с записями не удалить.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  addDormitory,
  deleteDormitory,
  listDormitories,
  updateDormitory,
  type IDormitoryFields,
} from '../services/dormitory-directory.service.js';
import { isPseudoApartmentAddress, PSEUDO_APARTMENT_ERROR, stayDateSchema } from './dormitory-stay-input.js';
import { payrollPositiveMoneySchema } from './payroll-dictionary.helpers.js';

const NOT_FOUND = { success: false, error: 'Общежитие не найдено' };
const DUPLICATE = { success: false, error: 'Общежитие с таким названием уже есть', code: 'DORMITORY_DUPLICATE' };
const HAS_STAYS = {
  success: false,
  error: 'В общежитии есть или были жильцы — удалить нельзя',
  code: 'DORMITORY_HAS_STAYS',
};

const squeeze = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Общежитие: название обязательно (не «Кв. …» — это служебная квартира), остальное — по желанию. */
export const dormitorySchema = z.object({
  address: z.string({ required_error: 'Укажите общежитие', invalid_type_error: 'Укажите общежитие' })
    .transform(squeeze)
    .pipe(z.string().min(1, 'Укажите общежитие').max(200, 'Общежитие — не больше 200 символов'))
    .refine(value => !isPseudoApartmentAddress(value), PSEUDO_APARTMENT_ERROR),
  doc_date: stayDateSchema('Неверная дата').nullable().optional().transform(value => value ?? null),
  doc_number: z.string({ invalid_type_error: 'Неверный номер' }).transform(squeeze)
    .pipe(z.string().max(30, 'Номер — не больше 30 символов'))
    .nullable().optional().transform(value => value || null),
  place_price: payrollPositiveMoneySchema('Неверная стоимость места').nullable().optional().transform(value => value ?? null),
}).transform((value): IDormitoryFields => value);

const handleZodError = (error: unknown, res: Response): boolean => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
};

const parseId = (req: AuthenticatedRequest): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** GET /api/dormitory/dormitories — справочник общежитий в порядке названия. */
const list = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listDormitories() });
  } catch (err) {
    console.error('dormitoryDirectory.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения общежитий' });
  }
};

/** POST /api/dormitory/dormitories { address, doc_date?, doc_number?, place_price? } — добавить общежитие. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const fields = dormitorySchema.parse(req.body);
    const added = await addDormitory(fields);
    if (added === 'duplicate') {
      res.status(409).json(DUPLICATE);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_ADDED', {
      entityType: 'dormitory_addresses',
      entityId: String(added.id),
      details: { ...added },
    });
    res.json({ success: true, data: added });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitoryDirectory.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления общежития' });
  }
};

/** PATCH /api/dormitory/dormitories/:id — изменить общежитие; новое название — и у всех его записей. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const fields = dormitorySchema.parse(req.body);
    const updated = await updateDormitory(id, fields);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'duplicate') {
      res.status(409).json(DUPLICATE);
      return;
    }
    const { before, after, readdressed } = updated;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await auditService.logFromRequest(req, req.user.id, 'DORMITORY_UPDATED', {
        entityType: 'dormitory_addresses',
        entityId: String(id),
        details: { from: { ...before }, to: { ...after }, stays_readdressed: readdressed },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitoryDirectory.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения общежития' });
  }
};

/** DELETE /api/dormitory/dormitories/:id — удалить общежитие без записей (ошибочно заведённое). */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const deleted = await deleteDormitory(id);
    if (deleted === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (deleted === 'has_stays') {
      res.status(409).json(HAS_STAYS);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_DELETED', {
      entityType: 'dormitory_addresses',
      entityId: String(id),
      details: { ...deleted },
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('dormitoryDirectory.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления общежития' });
  }
};

export const dormitoryDirectoryController = { list, add, update, remove };
