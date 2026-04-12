export type AccessAction = 'view' | 'edit';
export type EmployeePortalVariant = 'office' | 'object';
export type DataScope = 'self' | 'department' | 'all';

export interface AvailablePage {
  path: string;
  label: string;
}

export interface PermissionOption {
  code: string;
  label: string;
  description: string;
}

export interface PermissionGroup {
  code: string;
  label: string;
  description: string;
  exclusive: boolean;
  options: PermissionOption[];
}

export interface PageAccessEntry {
  role_code: string;
  page_path: string;
  can_view: boolean;
  can_edit: boolean;
}

export const EMPLOYEE_VARIANT_PREFIX = 'portal.employee.variant.';
export const DATA_SCOPE_PREFIX = 'data.scope.';

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    code: 'portal.employee.variant',
    label: 'Вариант кабинета /employee',
    description: 'Определяет, какой личный кабинет открывать пользователю на маршруте /employee.',
    exclusive: true,
    options: [
      {
        code: 'portal.employee.variant.office',
        label: 'Обычный кабинет',
        description: 'Обычный личный кабинет для офисных сотрудников и остальных ролей.',
      },
      {
        code: 'portal.employee.variant.object',
        label: 'Кабинет рабочего',
        description: 'Отдельный личный кабинет рабочего на объекте.',
      },
    ],
  },
  {
    code: 'data.scope',
    label: 'Область данных',
    description: 'Определяет, какие данные пользователя доступны внутри страниц.',
    exclusive: true,
    options: [
      {
        code: 'data.scope.self',
        label: 'Только свои данные',
        description: 'Пользователь видит только свои данные и свои документы.',
      },
      {
        code: 'data.scope.department',
        label: 'Только свой отдел',
        description: 'Пользователь видит данные своего отдела.',
      },
      {
        code: 'data.scope.all',
        label: 'Все данные',
        description: 'Пользователь видит данные всей организации.',
      },
    ],
  },
];

export const AVAILABLE_PAGES: AvailablePage[] = [
  { path: '/employee', label: 'Личный кабинет' },
  { path: '/employee/requests', label: 'Мои заявления' },
  { path: '/employee/payslips', label: 'Расчётные листки' },
  { path: '/employee/payments', label: 'История выплат' },
  { path: '/employee/documents', label: 'Мои документы' },
  { path: '/employee/timesheet', label: 'Мой табель' },
  { path: '/employee/history', label: 'Моя история' },
  { path: '/employee/salary-raise', label: 'Повышение оклада' },
  { path: '/dashboard', label: 'Дашборд' },
  { path: '/timesheet', label: 'Табель' },
  { path: '/timesheet-hr', label: 'Табели HR' },
  { path: '/leave-requests', label: 'Заявления' },
  { path: '/salary-raise-review', label: 'Проверка заявок на повышение' },
  { path: '/discipline', label: 'Дисциплина' },
  { path: '/skud-travel', label: 'Передвижения' },
  { path: '/employees', label: 'Сотрудники' },
  { path: '/skud-raw', label: 'Просмотр СКУД' },
  { path: '/skud-db', label: 'СКУД (база)' },
  { path: '/skud-monitor', label: 'Монитор Sigur' },
  { path: '/staff-control', label: 'Управление кадрами' },
  { path: '/skud-settings', label: 'Настройки СКУД' },
  { path: '/admin/users', label: 'Управление пользователями' },
  { path: '/admin/audit', label: 'Аудит данных' },
  { path: '/admin/roles', label: 'Управление ролями' },
  { path: '/admin/settings', label: 'Системные настройки' },
  { path: '/admin/schedules', label: 'Графики работы' },
  { path: '/admin/payslips', label: 'Управление расчётными листками' },
  { path: '/admin/payments', label: 'Управление выплатами' },
];

export const SCOPE_REQUIRED_PAGES = new Set<string>([
  '/employee',
  '/employee/requests',
  '/employee/payslips',
  '/employee/payments',
  '/employee/documents',
  '/employee/timesheet',
  '/employee/history',
  '/employee/salary-raise',
  '/dashboard',
  '/timesheet',
  '/timesheet-hr',
  '/leave-requests',
  '/salary-raise-review',
  '/discipline',
  '/skud-travel',
  '/employees',
  '/skud-raw',
  '/skud-db',
  '/skud-monitor',
  '/staff-control',
  '/admin/payslips',
  '/admin/payments',
]);

export const PAGE_ACCESS_KEYS = new Set(AVAILABLE_PAGES.map(page => page.path));

export function normalizePermissions(permissions: string[] | null | undefined): string[] {
  return [...new Set((permissions || []).filter(Boolean))].sort();
}

export function normalizePageAccessEntry<T extends PageAccessEntry>(entry: T): T {
  if (entry.can_edit && !entry.can_view) {
    return { ...entry, can_view: true };
  }
  return entry;
}

function countByPrefix(permissions: string[], prefix: string): number {
  return permissions.filter(permission => permission.startsWith(prefix)).length;
}

function pageAccessNeedsEmployeeVariant(pageAccess: Record<string, { can_view: boolean; can_edit: boolean }>): boolean {
  return pageAccess['/employee']?.can_view === true;
}

function pageAccessNeedsDataScope(pageAccess: Record<string, { can_view: boolean; can_edit: boolean }>): boolean {
  return Object.entries(pageAccess).some(([pagePath, access]) => access.can_view && SCOPE_REQUIRED_PAGES.has(pagePath));
}

export function resolveEmployeeVariantFromPermissions(
  permissions: string[] | null | undefined,
): EmployeePortalVariant | null {
  const normalized = normalizePermissions(permissions);
  if (normalized.includes('portal.employee.variant.object')) return 'object';
  if (normalized.includes('portal.employee.variant.office')) return 'office';
  return null;
}

export function resolveDataScopeFromPermissions(permissions: string[] | null | undefined): DataScope | null {
  const normalized = normalizePermissions(permissions);
  if (normalized.includes('data.scope.all')) return 'all';
  if (normalized.includes('data.scope.department')) return 'department';
  if (normalized.includes('data.scope.self')) return 'self';
  return null;
}

export function validateRoleConfiguration(
  roleCode: string,
  permissions: string[] | null | undefined,
  pageAccess: Record<string, { can_view: boolean; can_edit: boolean }>,
): string | null {
  const normalized = normalizePermissions(permissions);
  const variantCount = countByPrefix(normalized, EMPLOYEE_VARIANT_PREFIX);
  const dataScopeCount = countByPrefix(normalized, DATA_SCOPE_PREFIX);

  if (variantCount > 1) {
    return `Роль ${roleCode}: можно выбрать только один вариант кабинета /employee`;
  }
  if (dataScopeCount > 1) {
    return `Роль ${roleCode}: можно выбрать только одну область данных`;
  }
  if (pageAccessNeedsEmployeeVariant(pageAccess) && variantCount !== 1) {
    return `Роль ${roleCode}: для доступа к /employee нужно выбрать ровно один вариант кабинета`;
  }
  if (pageAccessNeedsDataScope(pageAccess) && dataScopeCount !== 1) {
    return `Роль ${roleCode}: для доступа к страницам с данными нужно выбрать ровно одну область данных`;
  }

  return null;
}
