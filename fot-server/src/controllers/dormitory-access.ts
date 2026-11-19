/**
 * Доступ вкладки «Проживание» «Управления кадрами» — один для проживаний, квартир, жильцов и компенсации
 * (dormitory-stays, company-apartments, dormitory-residents контроллеры):
 * - охват списка — как список кадров (resolveStaffRosterEmployeeIds); персональная галочка «Проживание»
 *   (миграция 351) — вся организация;
 * - запись — canWriteEmployeeInScope; уволенному (его назначения отделов сняты) — тот, кто видит его в «Уволенных».
 */
import type { AuthenticatedRequest } from '../types/index.js';
import { canWriteEmployeeInScope } from '../services/data-scope.service.js';
import { getEmployeeState } from '../services/dormitory-stays.service.js';
import {
  canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds,
} from '../services/employee-scope-filter.service.js';
import { getRequestStaffTabGrant } from '../services/staff-tab-access.service.js';

/** Галочка «Проживание» в назначениях (миграция 351): охват вкладки кадров — вся организация. */
export const hasDormitoryGrant = (req: AuthenticatedRequest): Promise<boolean> => getRequestStaffTabGrant(req, 'dormitory');

/** Охват списка кадров набором id; 'all' и галочка — null (без ограничения). */
export const rosterEmployeeIds = async (req: AuthenticatedRequest): Promise<number[] | null> => {
  if (await hasDormitoryGrant(req)) return null;
  const roster = await resolveStaffRosterEmployeeIds(req);
  return roster === 'all' ? null : [...roster];
};

/** Можно ли заселить работающего сотрудника: галочка или охват роли. */
export const canAddStay = async (req: AuthenticatedRequest, employeeId: number): Promise<boolean> => (
  await hasDormitoryGrant(req) || canWriteEmployeeInScope(req, employeeId)
);

/**
 * Можно ли менять проживание сотрудника. Уволенного увольнение выводит из назначений отделов,
 * и canWriteEmployeeInScope админу компании откажет — тогда решает «виден ли в списке кадров».
 */
export const canWriteStay = async (req: AuthenticatedRequest, employeeId: number): Promise<boolean> => {
  if (await canAddStay(req, employeeId)) return true;
  const employee = await getEmployeeState(employeeId);
  if (!employee || employee.employment_status === 'active') return false;
  return canSeeEmployeeInStaffList(req, employeeId);
};
