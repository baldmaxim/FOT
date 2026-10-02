/**
 * Рабочие: объект табелирования не по часам, а разбивка по фактическим проходам — как до
 * авторасчёта 29.09.2026.
 *
 * Рабочий — сотрудник с учёткой роли «Рабочий» (system_roles.code = 'worker') или сотрудник
 * раздела «Бригады» без учётки (раздел — как в «Управлении кадрами»). Ночной расчёт, фиксация
 * месяца, скрипт активации и «Вернуть» в окне «Режим табелирования» ставят рабочему режим skud
 * с set_by = 'auto': в «Едином 1С» и API 1С — по строке на каждый объект с проходами. Пару
 * skud/auto пишет только это правило — по ней табель узнаёт рабочего и показывает под ФИО его
 * объекты. Личный «Офис» и «Офис» отдела главнее (timesheet-office-rule.ts).
 */
import { query, type DbExecutor } from '../config/postgres.js';
import { listSectionDepartmentIds, type IExportDepartmentRow } from './employees-export.service.js';

/** Подпись цели правила в аудите и отчёте скрипта. */
export const WORKER_SKUD_LABEL = 'По СКУД';

/**
 * Отделы раздела «Бригады», включая неактивные: у уволенного отдел мог уже закрыться.
 * exec — клиент транзакции: состав раздела читается тем же снимком, что и сотрудники.
 */
export async function loadBrigadeDepartmentIds(exec?: DbExecutor): Promise<string[]> {
  const sql = 'SELECT id, parent_id, name, kind FROM org_departments';
  const rows = exec
    ? (await exec.query<IExportDepartmentRow>(sql)).rows
    : await query<IExportDepartmentRow>(sql);
  return listSectionDepartmentIds(rows, 'brigades');
}

/**
 * Рабочий: учётка с ролью «Рабочий» или бригадник без учётки. NULL-безопасно — всегда true
 * или false. departmentExpr — отдел, по которому проверяется раздел «Бригады»: у уволенного
 * это отдел до увольнения, а не «Уволенные».
 */
export function workerSql(
  alias: string,
  brigadesParam: string,
  departmentExpr = `${alias}.org_department_id`,
): string {
  return `(EXISTS (SELECT 1 FROM user_profiles wup
                      JOIN system_roles wsr ON wsr.id = wup.system_role_id
                     WHERE wup.employee_id = ${alias}.id AND wsr.code = 'worker')
        OR (${departmentExpr} IS NOT NULL
            AND ${departmentExpr} = ANY(${brigadesParam}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM user_profiles wnp WHERE wnp.employee_id = ${alias}.id)))`;
}
