/**
 * Персональные галочки «Проживание» и «Удержания» (миграция 351): сотрудник правит вкладку «Управления кадрами» по
 * всей организации, не меняя роль. Выдают в «Система → Назначения сотрудников».
 *
 * Галочка открывает только ключ своей вкладки: resolveEffectivePageAccess пропускает её до гейта admin_access, а охват
 * «все сотрудники» включают сами контроллеры вкладок (staff-deductions, dormitory-stays). Раздел «Зарплата» и
 * справочник видов удержаний галочка не открывает — там проверка по роли (resolveRolePageAccess).
 */
import type { PoolClient } from 'pg';

import { query } from '../config/postgres.js';
import type { AuthenticatedRequest, StaffTab } from '../types/index.js';

export const STAFF_TABS: readonly StaffTab[] = ['dormitory', 'deductions'];

/** Вкладка → ключ страницы, который она открывает. */
export const STAFF_TAB_PAGES: Readonly<Record<StaffTab, string>> = {
  dormitory: '/staff-control/dormitory',
  deductions: '/staff-control/deductions',
};

/** Вкладка по ключу страницы; null — ключ галочкой не выдаётся. */
export function staffTabByPage(pagePath: string): StaffTab | null {
  for (const tab of STAFF_TABS) {
    if (STAFF_TAB_PAGES[tab] === pagePath) return tab;
  }
  return null;
}

const isStaffTab = (value: unknown): value is StaffTab => STAFF_TABS.includes(value as StaffTab);

const selectGrants = async (employeeId: number): Promise<StaffTab[]> => {
  const rows = await query<{ tab: string }>(
    'SELECT tab FROM employee_staff_tab_access WHERE employee_id = $1',
    [employeeId],
  );
  return rows.map(row => row.tab).filter(isStaffTab);
};

/**
 * Галочки сотрудника. Их читают гард страниц и /auth/me, поэтому недоступная база (в том числе таблица до миграции 351)
 * означает «галочек нет» — fail-closed, а не 500.
 */
export async function listStaffTabGrants(employeeId: number | null | undefined): Promise<StaffTab[]> {
  if (!employeeId) return [];
  try {
    return await selectGrants(employeeId);
  } catch (err) {
    console.warn('[staff-tab-access] grant check failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Есть ли у текущего пользователя галочка вкладки; кэш на время HTTP-запроса. */
export async function getRequestStaffTabGrant(req: AuthenticatedRequest, tab: StaffTab): Promise<boolean> {
  if (req.user.__staff_tab_grants === undefined) {
    req.user.__staff_tab_grants = await listStaffTabGrants(req.user.employee_id);
  }
  return req.user.__staff_tab_grants.includes(tab);
}

/** Галочка для панели назначений: ошибка базы пробрасывается, а не подменяется «нет». */
export async function loadStaffTabGrant(employeeId: number, tab: StaffTab): Promise<boolean> {
  return (await selectGrants(employeeId)).includes(tab);
}

/** Поставить или снять галочку в транзакции вызывающего; true — что-то изменилось. */
export async function setStaffTabGrant(
  client: PoolClient,
  employeeId: number,
  tab: StaffTab,
  granted: boolean,
  createdBy: string | null,
): Promise<boolean> {
  const result = granted
    ? await client.query(
      `INSERT INTO employee_staff_tab_access (employee_id, tab, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id, tab) DO NOTHING
       RETURNING employee_id`,
      [employeeId, tab, createdBy],
    )
    : await client.query(
      'DELETE FROM employee_staff_tab_access WHERE employee_id = $1 AND tab = $2 RETURNING employee_id',
      [employeeId, tab],
    );
  return result.rows.length > 0;
}

export interface IStaffTabProfileFlags {
  /** Правка вкладки по роли — без галочки (справочник видов удержаний). */
  roleEdit: Record<StaffTab, boolean>;
  /** Может ставить галочку в назначениях: правка по роли + охват «вся организация». */
  canGrant: Record<StaffTab, boolean>;
}

/**
 * Поля профиля для фронта — зеркало серверных гардов: roleEdit = resolveRolePageAccess(ключ, 'edit') (is_admin или
 * матрица роли, уже очищенная от админ-ключей у роли без админки), canGrant = roleEdit и
 * resolveAccessibleDepartmentIds === 'all' (orgWide считает вызывающий).
 */
export function resolveStaffTabProfileFlags(input: {
  isAdmin: boolean;
  rolePageAccess: Record<string, { can_view: boolean; can_edit: boolean } | undefined>;
  orgWide: boolean;
}): IStaffTabProfileFlags {
  const roleEdit = {} as Record<StaffTab, boolean>;
  const canGrant = {} as Record<StaffTab, boolean>;
  for (const tab of STAFF_TABS) {
    roleEdit[tab] = input.isAdmin || input.rolePageAccess[STAFF_TAB_PAGES[tab]]?.can_edit === true;
    canGrant[tab] = roleEdit[tab] && input.orgWide;
  }
  return { roleEdit, canGrant };
}
