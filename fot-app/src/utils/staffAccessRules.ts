/**
 * Правила экрана «Управление кадрами → Текущие сотрудники» от прав пользователя.
 *
 * Зеркало серверного контракта (fot-server: read-scope-grants.service,
 * hasStaffAllEmployeesGrant): ключ «Управление кадрами — все сотрудники» действует только у
 * роли «Табельщица» — у других ролей галочка в матрице ничего не меняет, у администратора
 * своя логика. Всегда проверять через resolveStaffAccessRules, а не сырой ключ.
 */

import type { StaffSection } from '../components/staff/staffSections';

export const STAFF_ALL_EMPLOYEES_PAGE_KEY = '/staff-control/all-employees';

const TIMEKEEPER_ROLE_CODE = 'timekeeper';

interface IStaffAccessInput {
  isAdmin: boolean;
  roleCode: string | null | undefined;
  /** Ключ STAFF_ALL_EMPLOYEES_PAGE_KEY в матрице роли (canViewPage). */
  hasAllEmployeesKey: boolean;
  /** Правка кадров + «Все отделы»: администратор и кадровый админ. */
  canManageStaff: boolean;
  /** Скоуп по назначенным отделам: руководитель, табельщица. */
  isDepartmentScope: boolean;
}

export interface IStaffAccessRules {
  /** Вся организация на чтение: список не сужается, дерево отделов — полное. */
  hasAllEmployees: boolean;
  /** Фильтр отделов ограничен назначенными; единственный отдел фиксируется. */
  restrictToManaged: boolean;
  /** Переключатель «Действующие / Уволенные» и чипы «Устроены / Уволены» с начала месяца. */
  canViewFired: boolean;
  /**
   * Раздел, с которого открывается экран. «Все» — только тем, чей список сужен до своих
   * отделов: их отделы могут быть в СМ, и на «СУ-10» таблица была бы пустой. Кто видит всю
   * организацию (админ, кадровый админ, табельщица с правом) — «СУ-10».
   */
  defaultSection: StaffSection;
}

export const resolveStaffAccessRules = ({
  isAdmin,
  roleCode,
  hasAllEmployeesKey,
  canManageStaff,
  isDepartmentScope,
}: IStaffAccessInput): IStaffAccessRules => {
  const hasAllEmployees = !isAdmin && roleCode === TIMEKEEPER_ROLE_CODE && hasAllEmployeesKey;
  const restrictToManaged = isDepartmentScope && !hasAllEmployees;
  return {
    hasAllEmployees,
    restrictToManaged,
    canViewFired: canManageStaff || hasAllEmployees,
    defaultSection: restrictToManaged ? 'all' : 'su10',
  };
};

interface IStaffStatusPeriod<TStatus extends string, TPeriod> {
  status: TStatus | 'active';
  period: TPeriod | null;
}

/**
 * Статус и период «с начала месяца» из URL. Без права на «Уволенных» переключателя и чипов
 * на экране нет — чужая ссылка оставила бы скрытый фильтр: возвращаем «Действующих» и снимаем
 * период (независимо от статуса). С правом — как пришло.
 */
export const normalizeStaffStatusPeriod = <TStatus extends string, TPeriod>(
  state: IStaffStatusPeriod<TStatus, TPeriod>,
  canViewFired: boolean,
): IStaffStatusPeriod<TStatus, TPeriod> => (canViewFired ? state : { status: 'active', period: null });
