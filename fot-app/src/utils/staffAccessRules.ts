/**
 * Правила экрана «Управление кадрами → Текущие сотрудники» от прав пользователя.
 *
 * Зеркало серверного контракта (fot-server: read-scope-grants.service,
 * hasStaffAllEmployeesGrant): ключ «Управление кадрами — все сотрудники» действует только у
 * роли «Табельщица» — у других ролей галочка в матрице ничего не меняет, у администратора
 * своя логика. Всегда проверять через resolveStaffAccessRules, а не сырой ключ.
 */

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
}

export const resolveStaffAccessRules = ({
  isAdmin,
  roleCode,
  hasAllEmployeesKey,
  canManageStaff,
  isDepartmentScope,
}: IStaffAccessInput): IStaffAccessRules => {
  const hasAllEmployees = !isAdmin && roleCode === TIMEKEEPER_ROLE_CODE && hasAllEmployeesKey;
  return {
    hasAllEmployees,
    restrictToManaged: isDepartmentScope && !hasAllEmployees,
    canViewFired: canManageStaff || hasAllEmployees,
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
