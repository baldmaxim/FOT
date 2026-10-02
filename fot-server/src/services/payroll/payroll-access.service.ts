/**
 * Персональный доступ к разделу «Зарплата» (миграция 288, вкладка «Зарплата» в
 * «Система → Назначения сотрудников»).
 *
 * Роль у пользователя одна, поэтому бухгалтеру на роли «Офисный сотрудник» раздел через
 * матрицу ролей не выдать. Право живёт на назначении — как у заместителя (283) и
 * «Руководителя экономического отдела» (241): ветка в resolveEffectivePageAccess и
 * зеркало в page_access на /auth/me.
 *
 * Грант открывает весь раздел — ключи PAYROLL_GRANT_PAGES, охват — весь штат
 * (payroll-scope.service): «Просмотр» — чтение, «Редактирование» — и правка. Legacy-оклад вне
 * раздела («+ Оклад», импорт из Excel, события оклада в истории) грант не открывает.
 *
 * Администраторам грант не нужен и не учитывается: у них доступ по роли, а охват
 * админа компании ограничен его компанией — оставшийся грант его расширять не должен.
 */
import type { PoolClient } from 'pg';

import { PAGE_PATHS } from '../../config/access-control.js';
import { query, withTransaction } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';

export type PayrollAccessLevel = 'view' | 'edit';

/**
 * Ключи, которые открывает персональный грант, — весь раздел «Зарплата». Точный список, а не
 * префикс /salary/: новый ключ раздела попадает в грант только явным решением (контрактный
 * тест сверяет список с каталогом).
 */
export const PAYROLL_GRANT_PAGES: readonly string[] = [
  PAGE_PATHS.SALARY_PAYMENTS,
  PAGE_PATHS.SALARY_PAYMENTS_CALCULATE,
  PAGE_PATHS.SALARY_PAYMENTS_APPROVE,
  PAGE_PATHS.SALARY_TERMS,
  PAGE_PATHS.SALARY_SICK_LEAVES,
  PAGE_PATHS.SALARY_VACATIONS,
  PAGE_PATHS.SALARY_DEDUCTIONS,
  PAGE_PATHS.SALARY_ADMIN,
];

const PAYROLL_GRANT_PAGE_SET = new Set(PAYROLL_GRANT_PAGES);

/** Открывает ли персональный грант этот ключ. */
export const isPayrollGrantPage = (pagePath: string): boolean => PAYROLL_GRANT_PAGE_SET.has(pagePath);

const normalizeLevel = (value: unknown): PayrollAccessLevel | null => (
  value === 'view' || value === 'edit' ? value : null
);

/** Пускает ли уровень гранта к действию: edit — и чтение, и правка; view — только чтение. */
export const payrollGrantAllows = (
  level: PayrollAccessLevel | null,
  action: 'view' | 'edit',
): boolean => level === 'edit' || (level === 'view' && action === 'view');

/**
 * Уровень гранта сотрудника без поглощения ошибок — для админки: при сбое БД панель должна
 * показать ошибку, а не «Нет доступа», который потом можно случайно сохранить.
 */
export async function loadPayrollAccessLevel(employeeId: number): Promise<PayrollAccessLevel | null> {
  const rows = await query<{ access_level: string }>(
    'SELECT access_level FROM payroll_access_grants WHERE employee_id = $1',
    [employeeId],
  );
  return normalizeLevel(rows[0]?.access_level);
}

/**
 * Уровень гранта сотрудника для проверок прав. Межзапросного кэша нет: снятие доступа
 * должно действовать сразу. Предикат зовут page-гейты на путях без своей обработки ошибок
 * БД, поэтому недоступная база (в том числе таблица до миграции 288) означает «гранта нет» —
 * fail-closed, а не 500 на весь запрос.
 */
export async function getPayrollAccessLevel(
  employeeId: number | null | undefined,
): Promise<PayrollAccessLevel | null> {
  if (employeeId == null || !Number.isInteger(employeeId) || employeeId <= 0) return null;
  try {
    return await loadPayrollAccessLevel(employeeId);
  } catch (err) {
    console.warn('[payroll-access] grant check failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Грант текущего пользователя с кэшем на время HTTP-запроса (req.user): его читают
 * page-гейт и функции охвата «Зарплаты» в одном обработчике. Для is_admin — всегда null.
 */
export async function getRequestPayrollAccessLevel(
  req: AuthenticatedRequest,
): Promise<PayrollAccessLevel | null> {
  if (req.user.is_admin) return null;
  if (req.user.__payroll_access_level !== undefined) return req.user.__payroll_access_level;
  const level = await getPayrollAccessLevel(req.user.employee_id);
  req.user.__payroll_access_level = level;
  return level;
}

/**
 * Выдать, сменить или снять (level = null) грант. Возвращает прежний уровень.
 *
 * onChanged вызывается в той же транзакции и только при реальном изменении — туда пишется
 * аудит, чтобы смена доступа и запись о ней не разошлись. Ошибки БД пробрасываются:
 * сохранение из админки должно честно упасть, а не «успешно» ничего не записать.
 */
export async function setPayrollAccessLevel(
  employeeId: number,
  level: PayrollAccessLevel | null,
  grantedBy: string | null,
  onChanged?: (client: PoolClient, previous: PayrollAccessLevel | null) => Promise<void>,
): Promise<PayrollAccessLevel | null> {
  return withTransaction(async (client) => {
    const previousRows = await client.query<{ access_level: string }>(
      'SELECT access_level FROM payroll_access_grants WHERE employee_id = $1 FOR UPDATE',
      [employeeId],
    );
    const previous = normalizeLevel(previousRows.rows[0]?.access_level);
    if (previous === level) return previous;
    if (level === null) {
      await client.query('DELETE FROM payroll_access_grants WHERE employee_id = $1', [employeeId]);
    } else {
      await client.query(
        `INSERT INTO payroll_access_grants (employee_id, access_level, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (employee_id) DO UPDATE
           SET access_level = EXCLUDED.access_level,
               granted_by = EXCLUDED.granted_by,
               updated_at = now()`,
        [employeeId, level, grantedBy],
      );
    }
    if (onChanged) await onChanged(client, previous);
    return previous;
  });
}
