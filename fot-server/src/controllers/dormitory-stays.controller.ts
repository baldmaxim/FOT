/**
 * «Общежитие» (миграция 314): вкладка «Управления кадрами» (право /staff-control/dormitory) и таблица
 * только для чтения в «Зарплате» («Справочник» → кнопка «Общежитие»).
 *
 * Охват: список — как список кадров (resolveStaffRosterEmployeeIds), в «Зарплате» — как условия оплаты
 * (resolvePayrollReadableDepartmentIds). Запись — canWriteEmployeeInScope; уволенному (его назначения
 * отделов сняты) дату выезда ставит тот, кто видит его в «Уволенных» кадров.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { canWriteEmployeeInScope } from '../services/data-scope.service.js';
import {
  addStay,
  deleteStay,
  getEmployeeState,
  getStay,
  listStays,
  searchCandidates,
  updateStay,
  type IDormitoryStay,
} from '../services/dormitory-stays.service.js';
import {
  canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds,
} from '../services/employee-scope-filter.service.js';
import { resolvePayrollReadableDepartmentIds } from '../services/payroll/payroll-scope.service.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

const DORMITORY_SHEET = { sheetName: 'Общежитие', tableName: 'Dormitory' } as const;

/** YYYY-MM-DD, и такая дата есть в календаре: 31.02 — 400, а не ошибка PostgreSQL (500). */
const isCalendarDate = (value: string): boolean => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2100
    && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const dateSchema = (message: string) => z.string({ required_error: message, invalid_type_error: message })
  .regex(/^\d{4}-\d{2}-\d{2}$/, message)
  .refine(isCalendarDate, message);

const stayFields = {
  check_in: dateSchema('Укажите дату въезда'),
  check_out: dateSchema('Неверная дата выезда').nullable().optional().transform(value => value ?? null),
  address: z.string({ required_error: 'Укажите адрес или номер общежития' })
    .transform(value => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'Укажите адрес или номер общежития').max(200, 'Адрес — не больше 200 символов')),
};

/** Выезд строго позже въезда: в день выезда можно въехать снова (переселение). */
const checkOutAfterCheckIn = (value: { check_in: string; check_out: string | null }): boolean =>
  value.check_out === null || value.check_out > value.check_in;
const DATES_ORDER = { message: 'Дата выезда должна быть позже даты въезда', path: ['check_out'] };

const addSchema = z.object({
  employee_id: z.number({ required_error: 'Выберите сотрудника', invalid_type_error: 'Выберите сотрудника' })
    .int('Выберите сотрудника').positive('Выберите сотрудника'),
  ...stayFields,
}).refine(checkOutAfterCheckIn, DATES_ORDER);

const updateSchema = z.object(stayFields).refine(checkOutAfterCheckIn, DATES_ORDER);

const NOT_FOUND = { success: false, error: 'Запись не найдена' };
const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const OVERLAP = { success: false, error: 'Сотрудник уже живёт в общежитии в эти даты', code: 'DORMITORY_OVERLAP' };

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

/** Охват списка кадров набором id; 'all' — null (без ограничения). */
const rosterEmployeeIds = async (req: AuthenticatedRequest): Promise<number[] | null> => {
  const roster = await resolveStaffRosterEmployeeIds(req);
  return roster === 'all' ? null : [...roster];
};

/**
 * Можно ли менять проживание сотрудника. Уволенного увольнение выводит из назначений отделов,
 * и canWriteEmployeeInScope админу компании откажет — тогда решает «виден ли в списке кадров».
 */
const canWriteStay = async (req: AuthenticatedRequest, employeeId: number): Promise<boolean> => {
  if (await canWriteEmployeeInScope(req, employeeId)) return true;
  const employee = await getEmployeeState(employeeId);
  if (!employee || employee.employment_status === 'active') return false;
  return canSeeEmployeeInStaffList(req, employeeId);
};

const auditDetails = (stay: IDormitoryStay) => ({
  employee_id: stay.employee_id,
  full_name: stay.full_name,
  check_in: stay.check_in,
  check_out: stay.check_out,
  address: stay.address,
});

/** GET /api/dormitory/stays — все проживания в охвате списка кадров. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listStays({ employeeIds: await rosterEmployeeIds(req) }) });
  } catch (err) {
    console.error('dormitory.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/** GET /api/payroll/dormitory-stays — та же таблица в «Зарплате», охват условий оплаты. */
const listForPayroll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const departments = await resolvePayrollReadableDepartmentIds(req);
    res.json({
      success: true,
      data: await listStays({ departmentIds: departments === 'all' ? null : departments }),
    });
  } catch (err) {
    console.error('dormitory.listForPayroll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/** GET /api/dormitory/employees/search?q= — кого добавить: работающие в охвате, от 2 символов. */
const searchEmployees = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (search.length < 2) {
      res.json({ success: true, data: [] });
      return;
    }
    res.json({ success: true, data: await searchCandidates(search, await rosterEmployeeIds(req)) });
  } catch (err) {
    console.error('dormitory.searchEmployees error:', err);
    res.status(500).json({ success: false, error: 'Ошибка поиска' });
  }
};

/** POST /api/dormitory/stays { employee_id, check_in, check_out?, address } — добавить проживание. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId, ...input } = addSchema.parse(req.body);
    // Поиск отдаёт только работающих и не подрядчиков, но тело запроса могут собрать и руками.
    const employee = await getEmployeeState(employeeId);
    if (!employee) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if (employee.employment_status !== 'active' || employee.is_archived) {
      res.status(400).json({ success: false, error: 'Добавить можно только работающего сотрудника' });
      return;
    }
    if (employee.is_contractor) {
      res.status(400).json({ success: false, error: 'Подрядчика добавить нельзя' });
      return;
    }
    if (!(await canWriteEmployeeInScope(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const stay = await addStay(employeeId, input);
    if (stay === 'overlap') {
      res.status(409).json(OVERLAP);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_ADDED', {
      entityType: 'employee_dormitory_stays',
      entityId: String(stay.id),
      details: auditDetails(stay),
    });
    res.json({ success: true, data: stay });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitory.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления' });
  }
};

/** PATCH /api/dormitory/stays/:id { check_in, check_out?, address } — даты и адрес; сотрудник не меняется. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const input = updateSchema.parse(req.body);
    const current = await getStay(id);
    if (!current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWriteStay(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const updated = await updateStay(id, input);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'overlap') {
      res.status(409).json(OVERLAP);
      return;
    }
    const { before, after } = updated;
    if (before.check_in !== after.check_in || before.check_out !== after.check_out || before.address !== after.address) {
      await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_UPDATED', {
        entityType: 'employee_dormitory_stays',
        entityId: String(id),
        details: { from: auditDetails(before), to: auditDetails(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitory.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
};

/** DELETE /api/dormitory/stays/:id — удалить проживание (ошибочную запись). */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    const current = id === null ? null : await getStay(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWriteStay(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const deleted = await deleteStay(id);
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_DELETED', {
      entityType: 'employee_dormitory_stays',
      entityId: String(id),
      details: auditDetails(deleted),
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('dormitory.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления' });
  }
};

/**
 * POST /api/dormitory/stays/export — xlsx ровно как на экране: сортировка и фильтры применены
 * на клиенте, сервер только оформляет лист (до 1000 строк).
 */
const exportTable = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await sendTableSnapshotXlsx(res, req.body, DORMITORY_SHEET);
  } catch (err) {
    if (handleZodError(err, res)) return;
    console.error('dormitory.export error:', err);
    res.status(500).json({ success: false, error: 'Не удалось выгрузить таблицу' });
  }
};

export const dormitoryStaysController = {
  list,
  listForPayroll,
  searchEmployees,
  add,
  update,
  remove,
  exportTable,
};
