/**
 * «Управление кадрами» → «Проживание» (миграция 371): вкладка «Общежитие» (жильцы со сведениями), «Переселить»,
 * «Платно» и комментарий записи, вкладка «Компенсация аренды». Право — вкладки «Проживание» (/staff-control/dormitory):
 * чтение — view, запись — edit (гарды в dormitory.routes.ts); охват — список кадров (rosterEmployeeIds), запись по
 * сотруднику — canWriteStay, как у проживаний.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { listCompensationMonth } from '../services/dormitory-compensation.service.js';
import {
  loadLastPasses,
  loadMaskedPassports,
  loadSupervisorLabels,
} from '../services/dormitory-residents.service.js';
import { moveStay } from '../services/dormitory-stay-move.service.js';
import {
  getStay,
  listStaysOfClass,
  updateStayMeta,
  type IDormitoryStay,
} from '../services/dormitory-stays.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { canWriteStay, rosterEmployeeIds } from './dormitory-access.js';
import {
  dormitoryStayAuditDetails,
  dormitoryStayChanged,
  isPseudoApartmentAddress,
  PSEUDO_APARTMENT_ERROR,
  stayMetaSchema,
  stayMoveSchema,
} from './dormitory-stay-input.js';

const NOT_FOUND = { success: false, error: 'Запись не найдена' };
const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };

/** Жилец общежития: проживание + сведения (только у живущих сейчас и заселяемых позже). */
export interface IDormitoryResident extends IDormitoryStay {
  /** Последние 4 знака (••••••3158); нет реквизитов — null. */
  passport: string | null;
  /** YYYY-MM-DDTHH:MM:SS по Москве. */
  last_pass_at: string | null;
  last_access_point: string | null;
  supervisor: string | null;
}

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

/** Первое число месяца даты YYYY-MM-DD. */
const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

/**
 * GET /api/dormitory/residents — общежития (без служебных квартир): все записи охвата с историей; сведения
 * (паспорт, крайний проход, начальник участка) — у тех, чья запись ещё не закончилась (выезд позже сегодня или нет).
 */
const residents = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const today = moscowTodayIso();
    const stays = await listStaysOfClass('dormitory', await rosterEmployeeIds(req));
    const active = stays.filter(stay => stay.check_out === null || stay.check_out > today);
    const ids = active.map(stay => stay.employee_id);
    const [passports, passes, supervisors] = await Promise.all([
      loadMaskedPassports(ids),
      loadLastPasses(ids, today),
      loadSupervisorLabels(active.map(stay => ({ employee_id: stay.employee_id, org_department_id: stay.org_department_id }))),
    ]);
    const activeIds = new Set(active.map(stay => stay.id));
    const data: IDormitoryResident[] = stays.map(stay => {
      const withExtras = activeIds.has(stay.id);
      const pass = withExtras ? passes.get(stay.employee_id) : undefined;
      return {
        ...stay,
        passport: withExtras ? passports.get(stay.employee_id) ?? null : null,
        last_pass_at: pass?.at ?? null,
        last_access_point: pass?.access_point ?? null,
        supervisor: withExtras ? supervisors.get(stay.employee_id) ?? null : null,
      };
    });
    res.json({ success: true, data: { today, residents: data } });
  } catch (err) {
    console.error('dormitoryResidents.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения жильцов' });
  }
};

/**
 * PATCH /api/dormitory/stays/:id/meta { paid?, comment? } — «Платно» (только жилец служебной квартиры) и/или
 * комментарий; остальные поля не трогаются. Без изменений — 200 без аудита.
 */
const updateMeta = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    const current = id === null ? null : await getStay(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const input = stayMetaSchema.parse(req.body ?? {});
    if (!(await canWriteStay(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const updated = await updateStayMeta(id, input);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'not_flat') {
      res.status(400).json({ success: false, error: '«Платно» отмечают только у жильца служебной квартиры' });
      return;
    }
    const { before, after } = updated;
    if (dormitoryStayChanged(before, after)) {
      await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_UPDATED', {
        entityType: 'employee_dormitory_stays',
        entityId: String(id),
        details: { from: dormitoryStayAuditDetails(before), to: dormitoryStayAuditDetails(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitoryResidents.updateMeta error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
};

const MOVE_ERRORS: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: 'Запись не найдена' },
  not_movable: { status: 400, error: 'Переселяют только из общежития или служебной квартиры' },
  apartment_not_found: { status: 404, error: 'Квартира не найдена' },
  same_place: { status: 400, error: 'Сотрудник уже живёт здесь' },
  before_check_in: { status: 400, error: 'Дата переселения должна быть позже даты въезда' },
  not_open: { status: 400, error: 'В эту дату сотрудник здесь уже не живёт' },
  overlap: { status: 409, error: 'В эти даты у сотрудника уже есть другое проживание' },
};

/**
 * POST /api/dormitory/stays/:id/move { date, address | apartment_id } — переселить с даты (с 1-го числа текущего
 * месяца по сегодня МСК: закрытые и будущие месяцы не трогаются) в другое общежитие или служебную квартиру. Аудит —
 * закрытие и заселение с общим move_id; повтор того же запроса — 200 без изменений и без аудита.
 */
const move = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    const current = id === null ? null : await getStay(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const input = stayMoveSchema.parse(req.body ?? {});
    const today = moscowTodayIso();
    if (input.date < monthStart(today) || input.date > today) {
      res.status(400).json({ success: false, error: 'Дата переселения — с 1-го числа текущего месяца по сегодня' });
      return;
    }
    if (input.address !== null && isPseudoApartmentAddress(input.address)) {
      res.status(400).json({ success: false, error: PSEUDO_APARTMENT_ERROR });
      return;
    }
    if (!(await canWriteStay(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const result = await moveStay(
      id,
      input.date,
      input.apartment_id !== null ? { apartmentId: input.apartment_id } : { address: input.address as string },
    );
    if (typeof result === 'string') {
      const failure = MOVE_ERRORS[result];
      res.status(failure.status).json({ success: false, error: failure.error });
      return;
    }
    if (!result.repeated) {
      const moveId = randomUUID();
      await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_UPDATED', {
        entityType: 'employee_dormitory_stays',
        entityId: String(result.closed.id),
        details: {
          move_id: moveId,
          from: dormitoryStayAuditDetails({ ...result.closed, check_out: current.check_out }),
          to: dormitoryStayAuditDetails(result.closed),
        },
      });
      await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_ADDED', {
        entityType: 'employee_dormitory_stays',
        entityId: String(result.opened.id),
        details: { move_id: moveId, ...dormitoryStayAuditDetails(result.opened) },
      });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitoryResidents.move error:', err);
    res.status(500).json({ success: false, error: 'Ошибка переселения' });
  }
};

const monthQuerySchema = z.string({ required_error: 'Выберите месяц', invalid_type_error: 'Выберите месяц' })
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Выберите месяц');

/**
 * GET /api/dormitory/compensation?month=YYYY-MM — «Компенсация аренды» месяца: компенсации охвата списка кадров
 * (и уволенные, чьё проживание задевает месяц) с днями и суммой из расчёта ФОТ.
 */
const compensation = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const month = monthQuerySchema.parse(req.query.month);
    const rows = await listCompensationMonth(await rosterEmployeeIds(req), month, req);
    res.json({ success: true, data: rows });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitoryResidents.compensation error:', err);
    res.status(500).json({ success: false, error: 'Ошибка расчёта компенсации' });
  }
};

export const dormitoryResidentsController = { residents, updateMeta, move, compensation };
