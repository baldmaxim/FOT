/**
 * Расчётный лист в личном кабинете (миграция 353): страница /employee/payslip.
 *
 * Видят сотрудники из списка employee_payslip_access, а при system_settings.employee_payslip_for_all = 'true' — все
 * учётки с привязанным сотрудником. Учётка без сотрудника листка не видит никогда: листок — данные сотрудника.
 * Роль доступа не даёт и не отнимает, администраторам тоже: ветка в resolveEffectivePageAccess стоит до обхода
 * is_admin, + зеркало в page_access на /auth/me. Межзапросного кэша нет — список и переключатель действуют сразу.
 */
import { PAGE_PATHS } from '../config/access-control.js';
import { query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';

export const EMPLOYEE_PAYSLIP_PAGE: string = PAGE_PATHS.EMPLOYEE_PAYSLIP;

/** Настройка «всем»: только ровно 'true'; нет строки или другое значение — по списку. */
export const EMPLOYEE_PAYSLIP_FOR_ALL_KEY = 'employee_payslip_for_all';

/**
 * Видит ли сотрудник свой листок. Предикат зовут page-гейт и /auth/me, поэтому недоступная база (в том числе таблицы
 * до миграции 353) означает «нет доступа» — fail-closed, а не 500.
 */
export async function hasEmployeePayslipAccess(employeeId: number | null | undefined): Promise<boolean> {
  if (!employeeId) return false;
  try {
    const rows = await query<{ allowed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM employee_payslip_access WHERE employee_id = $1)
              OR COALESCE((SELECT value = 'true' FROM system_settings WHERE key = $2), false) AS allowed`,
      [employeeId, EMPLOYEE_PAYSLIP_FOR_ALL_KEY],
    );
    return rows[0]?.allowed === true;
  } catch (err) {
    console.warn('[employee-payslip-access] access check failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Доступ текущего пользователя с кэшем на время HTTP-запроса. */
export async function getRequestEmployeePayslipAccess(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.__employee_payslip_access !== undefined) return req.user.__employee_payslip_access;
  const allowed = await hasEmployeePayslipAccess(req.user.employee_id);
  req.user.__employee_payslip_access = allowed;
  return allowed;
}
