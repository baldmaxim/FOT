/**
 * «Управление кадрами» → «Проживание» → «Квартира» (миграция 371): служебные квартиры компании и их жильцы.
 * Право — вкладки «Проживание» (/staff-control/dormitory): список — view, запись — edit (гарды в dormitory.routes.ts).
 *
 * Квартира (адрес, пометка, комнат, мест, цена, «оплачено по») — без ФИО, видна всем с доступом к вкладке. Жильцы,
 * их телефоны, отпуск и объект — только сотрудники охвата списка кадров (rosterEmployeeIds): квартира может
 * показать меньше жильцов, чем живёт, но чужого сотрудника не раскроет. Сведения (телефон, отпуск, объект) — только
 * у живущих сейчас; у истории — даты.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  addApartment,
  deleteApartment,
  listApartments,
  updateApartment,
  type ICompanyApartment,
  type ICompanyApartmentFields,
} from '../services/company-apartments.service.js';
import { loadNearestVacations, loadPhones } from '../services/dormitory-residents.service.js';
import { listStaysOfClass, type IDormitoryStay } from '../services/dormitory-stays.service.js';
import { loadMainObjects } from '../services/employee-main-object-snapshot.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { rosterEmployeeIds } from './dormitory-access.js';
import { payrollPositiveMoneySchema } from './payroll-dictionary.helpers.js';
import { resolveExportPeriod } from './employees-export.controller.js';

const NOT_FOUND = { success: false, error: 'Квартира не найдена' };
const DUPLICATE = { success: false, error: 'Квартира с таким адресом уже есть', code: 'APARTMENT_DUPLICATE' };
const HAS_STAYS = {
  success: false,
  error: 'В квартире есть жильцы или история проживания — удалить нельзя',
  code: 'APARTMENT_HAS_STAYS',
};

/** Жилец квартиры: проживание + сведения (только у живущих сейчас). */
export interface IApartmentResident extends IDormitoryStay {
  phone: string | null;
  /** YYYY-MM-DD — текущий или ближайший согласованный отпуск. */
  vacation_from: string | null;
  vacation_to: string | null;
  main_object: string | null;
}

const squeeze = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** YYYY-MM-DD, и такая дата есть в календаре. */
const isCalendarDate = (value: string): boolean => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2100
    && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const optionalCount = (label: string) => z.number({ invalid_type_error: `Неверное число: ${label}` })
  .int(`${label} — целое число`).positive(`${label} — больше нуля`).max(99, `${label} — не больше 99`)
  .nullable().optional().transform(value => value ?? null);

/** Квартира: адрес обязателен (без «Кв.» — его подставляет система), остальное — по желанию. */
const apartmentSchema = z.object({
  address: z.string({ required_error: 'Укажите адрес квартиры', invalid_type_error: 'Укажите адрес квартиры' })
    .transform(value => squeeze(value).replace(/^кв[.\s]\s*/i, ''))
    .pipe(z.string().min(1, 'Укажите адрес квартиры').max(200, 'Адрес — не больше 200 символов')),
  note: z.string({ invalid_type_error: 'Неверная пометка' }).transform(squeeze)
    .pipe(z.string().max(100, 'Пометка — не больше 100 символов'))
    .nullable().optional().transform(value => value || null),
  rooms: optionalCount('Комнат'),
  places: optionalCount('Мест'),
  price: payrollPositiveMoneySchema('Неверная цена').nullable().optional().transform(value => value ?? null),
  paid_until: z.string({ invalid_type_error: 'Неверная дата «Оплачено по»' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Неверная дата «Оплачено по»')
    .refine(isCalendarDate, 'Неверная дата «Оплачено по»')
    .nullable().optional().transform(value => value ?? null),
}).transform((value): ICompanyApartmentFields => value);

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

const apartmentAuditDetails = (apartment: ICompanyApartment) => ({ ...apartment });

/** Сведения живущих сейчас: телефон, отпуск, объект (тот же период, что «Основной объект» «Управления кадрами»). */
const withResidentExtras = async (stays: IDormitoryStay[], today: string): Promise<IApartmentResident[]> => {
  const currentIds = stays
    .filter(stay => stay.check_in <= today && (stay.check_out === null || stay.check_out > today))
    .map(stay => stay.employee_id);
  const [phones, vacations, objects] = await Promise.all([
    loadPhones(currentIds),
    loadNearestVacations(currentIds, today),
    currentIds.length > 0 ? loadMainObjects([...new Set(currentIds)], resolveExportPeriod()) : null,
  ]);
  const current = new Set(currentIds);
  return stays.map(stay => {
    const isCurrent = current.has(stay.employee_id)
      && stay.check_in <= today && (stay.check_out === null || stay.check_out > today);
    const vacation = isCurrent ? vacations.get(stay.employee_id) ?? null : null;
    return {
      ...stay,
      phone: isCurrent ? phones.get(stay.employee_id) ?? null : null,
      vacation_from: vacation?.from ?? null,
      vacation_to: vacation?.to ?? null,
      main_object: isCurrent ? objects?.objects.get(stay.employee_id) ?? null : null,
    };
  });
};

/** GET /api/dormitory/apartments — квартиры и жильцы (сейчас, будущие и история) в охвате списка кадров. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const today = moscowTodayIso();
    const [apartments, stays] = await Promise.all([
      listApartments(),
      rosterEmployeeIds(req).then(ids => listStaysOfClass('flat', ids)),
    ]);
    res.json({ success: true, data: { today, apartments, residents: await withResidentExtras(stays, today) } });
  } catch (err) {
    console.error('companyApartments.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения квартир' });
  }
};

/** POST /api/dormitory/apartments { address, note?, rooms?, places?, price?, paid_until? } — добавить квартиру. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const fields = apartmentSchema.parse(req.body);
    const added = await addApartment(fields);
    if (added === 'duplicate') {
      res.status(409).json(DUPLICATE);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'COMPANY_APARTMENT_ADDED', {
      entityType: 'company_apartments',
      entityId: String(added.id),
      details: apartmentAuditDetails(added),
    });
    res.json({ success: true, data: added });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('companyApartments.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления квартиры' });
  }
};

/** PATCH /api/dormitory/apartments/:id — изменить квартиру; новый адрес — и у всех её проживаний (копия «Кв. …»). */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const fields = apartmentSchema.parse(req.body);
    const updated = await updateApartment(id, fields);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'duplicate') {
      res.status(409).json(DUPLICATE);
      return;
    }
    const { before, after, relinked } = updated;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await auditService.logFromRequest(req, req.user.id, 'COMPANY_APARTMENT_UPDATED', {
        entityType: 'company_apartments',
        entityId: String(id),
        details: { from: apartmentAuditDetails(before), to: apartmentAuditDetails(after), stays_readdressed: relinked },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('companyApartments.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения квартиры' });
  }
};

/** DELETE /api/dormitory/apartments/:id — удалить квартиру без проживаний (ошибочно заведённую). */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const deleted = await deleteApartment(id);
    if (deleted === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (deleted === 'has_stays') {
      res.status(409).json(HAS_STAYS);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'COMPANY_APARTMENT_DELETED', {
      entityType: 'company_apartments',
      entityId: String(id),
      details: apartmentAuditDetails(deleted),
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('companyApartments.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления квартиры' });
  }
};

export const companyApartmentsController = { list, add, update, remove };
