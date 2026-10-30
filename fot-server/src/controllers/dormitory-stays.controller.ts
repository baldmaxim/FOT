/**
 * «Проживание» (миграции 314, 320): вкладка «Управления кадрами» (право /staff-control/dormitory) — общежития
 * и квартиры; общежития только для чтения — в «Зарплате» («Справочник» → кнопка «Общежитие»). Квартиры — те же
 * записи, что «Доплата за проживание» «Зарплаты» (payroll-housing.controller.ts). Сумму квартиры кадры не задают:
 * новой — ставка «Доплата за проживание», при правке — прежняя; меняет её только «Зарплата».
 *
 * Охват: список — как список кадров (resolveStaffRosterEmployeeIds), в «Зарплате» — «штат зарплаты»
 * (работающие, без подрядчиков, охват условий оплаты). Запись — canWriteEmployeeInScope; уволенному (его
 * назначения отделов сняты) дату выезда ставит тот, кто видит его в «Уволенных» кадров.
 * «Зарплата» («Справочник» → «Общежитие», список живущих — миграция 339: он гасит авто-доплату за общежитие)
 * заселяет (POST), выселяет с даты (PATCH, выезд только раньше прежнего) и удаляет ошибочную строку — право
 * /salary/terms или /salary/payments и запись в «Справочник» (canWritePayrollRegistryEmployee); адреса и въезд
 * при заселении — те же правила, что у кадров.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { canWriteEmployeeInScope } from '../services/data-scope.service.js';
import { DormitoryAllowanceConflictError } from '../services/payroll/payroll-dormitory-allowances.service.js';
import {
  addStay,
  deleteStay,
  getEmployeeState,
  getHousingRateAmount,
  getStay,
  listAddresses,
  listPayrollDormitoryStays,
  listStays,
  searchCandidates,
  updateStay,
} from '../services/dormitory-stays.service.js';
import {
  canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds,
} from '../services/employee-scope-filter.service.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import {
  dormitoryStayAuditDetails,
  dormitoryStayChanged,
  parseStayFields,
  stayEmployeeIdSchema,
  stayKindSchema,
} from './dormitory-stay-input.js';
import { withCanEdit } from './payroll-dictionary.helpers.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

const DORMITORY_SHEET = { sheetName: 'Проживание', tableName: 'Housing' } as const;
const PAYROLL_AUDIT_SOURCE = 'payroll_dormitory_registry';

const NOT_FOUND = { success: false, error: 'Запись не найдена' };
const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const OVERLAP = {
  success: false,
  error: 'В эти даты у сотрудника уже есть проживание — в общежитии или квартире',
  code: 'DORMITORY_OVERLAP',
};
const HOUSING_RATE_MISSING = {
  success: false,
  error: 'Задайте ставку «Доплата за проживание» в «Зарплате» → «Справочник» → «Ставки»',
  code: 'HOUSING_RATE_MISSING',
};

/** Ошибка проверки или правило «одна доплата из двух» — ответ отправлен. */
const handleStayError = (error: unknown, res: Response): boolean => {
  if (handleZodError(error, res)) return true;
  if (error instanceof DormitoryAllowanceConflictError) {
    res.status(409).json({ success: false, error: error.message, code: error.code });
    return true;
  }
  return false;
};

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

/** GET /api/dormitory/stays — все проживания (общежития и квартиры) в охвате списка кадров. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listStays({ employeeIds: await rosterEmployeeIds(req) }) });
  } catch (err) {
    console.error('dormitory.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/**
 * GET /api/payroll/dormitory-stays — общежития «штата зарплаты» («Справочник» → «Общежитие»): уволенных нет;
 * can_edit — можно ли убрать.
 */
const listForPayroll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const [scope, canEdit] = await Promise.all([resolvePayrollStaffScope(req), resolvePayrollEditPredicate(req)]);
    res.json({ success: true, data: withCanEdit(await listPayrollDormitoryStays(scope), canEdit) });
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

/** GET /api/dormitory/addresses — сохранённые адреса для подсказок «Адрес / номер» (миграция 319). */
const listSavedAddresses = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listAddresses() });
  } catch (err) {
    console.error('dormitory.listAddresses error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения адресов' });
  }
};

/**
 * POST /api/dormitory/stays { employee_id, kind?, check_in, check_out?, address? } — добавить проживание:
 * общежитие (адрес обязателен) или квартиру (адрес — по желанию; сумма — ставка «Доплата за проживание»,
 * не задана — 409).
 */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId } = stayEmployeeIdSchema.parse(req.body);
    const { kind } = stayKindSchema.parse(req.body);
    const input = { kind, ...parseStayFields(kind, req.body, { withAmount: false }) };
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
    if (kind === 'apartment') {
      const rate = Number(await getHousingRateAmount());
      if (!(rate > 0)) {
        res.status(409).json(HOUSING_RATE_MISSING);
        return;
      }
      input.amount = rate;
    }
    const stay = await addStay(employeeId, input);
    if (stay === 'overlap') {
      res.status(409).json(OVERLAP);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_ADDED', {
      entityType: 'employee_dormitory_stays',
      entityId: String(stay.id),
      details: dormitoryStayAuditDetails(stay),
    });
    res.json({ success: true, data: stay });
  } catch (err) {
    if (handleStayError(err, res)) return;
    console.error('dormitory.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления' });
  }
};

/**
 * PATCH /api/dormitory/stays/:id { check_in, check_out?, address? } — даты и адрес; сотрудник, вид и сумма квартиры
 * не меняются (сумму правит «Зарплата»).
 */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const current = await getStay(id);
    if (!current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    // Без суммы: у квартиры остаётся прежняя (её меняет «Зарплата»).
    const input = parseStayFields(current.kind, req.body, { withAmount: false });
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
    if (dormitoryStayChanged(before, after)) {
      await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_UPDATED', {
        entityType: 'employee_dormitory_stays',
        entityId: String(id),
        details: { from: dormitoryStayAuditDetails(before), to: dormitoryStayAuditDetails(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handleStayError(err, res)) return;
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
      details: dormitoryStayAuditDetails(deleted),
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('dormitory.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления' });
  }
};

/**
 * POST /api/payroll/dormitory-stays { employee_id, check_in, check_out?, address } — «Зарплата» заселяет в общежитие:
 * работающий не подрядчик, запись в «Справочник»; пересечение с другим проживанием — 409.
 */
const addForPayroll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId } = stayEmployeeIdSchema.parse(req.body);
    const input = { kind: 'dormitory' as const, ...parseStayFields('dormitory', req.body) };
    // Поиск отдаёт только «штат зарплаты», но тело запроса могут собрать и руками.
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
    if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
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
      details: { source: PAYROLL_AUDIT_SOURCE, ...dormitoryStayAuditDetails(stay) },
    });
    res.json({ success: true, data: { ...stay, can_edit: true } });
  } catch (err) {
    if (handleStayError(err, res)) return;
    console.error('dormitory.addForPayroll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления' });
  }
};

/** Общежитие по :id, которое «Зарплата» может убрать; иначе ответ отправлен и null. */
const payrollRemovableDormitory = async (req: AuthenticatedRequest, res: Response) => {
  const id = parseId(req);
  const current = id === null ? null : await getStay(id);
  if (id === null || !current || current.kind !== 'dormitory') {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
    res.status(403).json(NO_ACCESS);
    return null;
  }
  return { id, current };
};

/**
 * PATCH /api/payroll/dormitory-stays/:id { check_out } — «Зарплата» убирает из общежития с даты: выезд только
 * раньше прежнего; въезд и адрес не меняются (их ведут кадры).
 */
const closeForPayroll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = await payrollRemovableDormitory(req, res);
    if (!target) return;
    const { current } = target;
    const fields = parseStayFields('dormitory', {
      check_in: current.check_in,
      check_out: (req.body as { check_out?: unknown } | undefined)?.check_out,
      address: current.address,
    });
    if (fields.check_out === null || (current.check_out !== null && fields.check_out > current.check_out)) {
      res.status(400).json({ success: false, error: 'Дату выезда можно только приблизить' });
      return;
    }
    const updated = await updateStay(target.id, fields);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'overlap') {
      res.status(409).json(OVERLAP);
      return;
    }
    const { before, after } = updated;
    if (dormitoryStayChanged(before, after)) {
      await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_UPDATED', {
        entityType: 'employee_dormitory_stays',
        entityId: String(target.id),
        details: { source: PAYROLL_AUDIT_SOURCE, from: dormitoryStayAuditDetails(before), to: dormitoryStayAuditDetails(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handleStayError(err, res)) return;
    console.error('dormitory.closeForPayroll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
};

/** DELETE /api/payroll/dormitory-stays/:id — «Зарплата» удаляет ошибочную строку общежития. */
const removeForPayroll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = await payrollRemovableDormitory(req, res);
    if (!target) return;
    const deleted = await deleteStay(target.id);
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_DELETED', {
      entityType: 'employee_dormitory_stays',
      entityId: String(target.id),
      details: { source: PAYROLL_AUDIT_SOURCE, ...dormitoryStayAuditDetails(deleted) },
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('dormitory.removeForPayroll error:', err);
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
  addForPayroll,
  closeForPayroll,
  removeForPayroll,
  searchEmployees,
  listAddresses: listSavedAddresses,
  add,
  update,
  remove,
  exportTable,
};
