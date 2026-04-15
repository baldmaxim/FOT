export type AccessAction = 'view' | 'edit';
export type AccessMode = 'none' | 'view' | 'edit';
export type AccessPageSurface = 'page' | 'technical';
export type EmployeePortalVariant = 'office' | 'object';
export type DataScope = 'self' | 'department' | 'all';

export interface PageCatalogItem {
  key: string;
  label: string;
  group_code: string;
  group_label: string;
  surface: AccessPageSurface;
  supports_edit: boolean;
  requires_data_scope: boolean;
  requires_employee_variant: boolean;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
}

export interface PermissionOption {
  code: string;
  label: string;
  description: string;
  sort_order: number;
}

export interface PermissionGroup {
  code: string;
  label: string;
  description: string;
  exclusive: boolean;
  sort_order: number;
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
export const CRITICAL_ADMIN_PAGE_KEYS = ['/admin/roles', '/admin/users'] as const;

export const DEFAULT_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    code: 'portal.employee.variant',
    label: 'Вариант кабинета /employee',
    description: 'Определяет, какой личный кабинет открывать пользователю на маршруте /employee.',
    exclusive: true,
    sort_order: 10,
    options: [
      {
        code: 'portal.employee.variant.office',
        label: 'Обычный кабинет',
        description: 'Обычный личный кабинет для офисных сотрудников и остальных ролей.',
        sort_order: 10,
      },
      {
        code: 'portal.employee.variant.object',
        label: 'Кабинет рабочего',
        description: 'Отдельный личный кабинет рабочего на объекте.',
        sort_order: 20,
      },
    ],
  },
  {
    code: 'data.scope',
    label: 'Область данных',
    description: 'Определяет, какие данные пользователя доступны внутри страниц.',
    exclusive: true,
    sort_order: 20,
    options: [
      {
        code: 'data.scope.self',
        label: 'Только свои данные',
        description: 'Пользователь видит только свои данные и свои документы.',
        sort_order: 10,
      },
      {
        code: 'data.scope.department',
        label: 'Только свой отдел',
        description: 'Пользователь видит данные своего отдела.',
        sort_order: 20,
      },
      {
        code: 'data.scope.all',
        label: 'Все данные',
        description: 'Пользователь видит данные всей организации.',
        sort_order: 30,
      },
    ],
  },
];

export const DEFAULT_ACCESS_PAGE_CATALOG: PageCatalogItem[] = [
  {
    key: '/employee',
    label: 'Личный кабинет',
    group_code: 'employee',
    group_label: 'Личный кабинет',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: true,
    sort_order: 10,
    is_active: true,
    is_system: true,
  },
  {
    key: '/employee/requests',
    label: 'Мои заявления',
    group_code: 'employee',
    group_label: 'Личный кабинет',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 20,
    is_active: true,
    is_system: true,
  },
  {
    key: '/employee/payslips',
    label: 'Расчётные листки',
    group_code: 'employee',
    group_label: 'Личный кабинет',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 30,
    is_active: true,
    is_system: true,
  },
  {
    key: '/employee/payments',
    label: 'История выплат',
    group_code: 'employee',
    group_label: 'Личный кабинет',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 40,
    is_active: true,
    is_system: true,
  },
  {
    key: '/employee/documents',
    label: 'Мои документы',
    group_code: 'employee',
    group_label: 'Личный кабинет',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 50,
    is_active: true,
    is_system: true,
  },
  {
    key: '/employee/timesheet',
    label: 'Мой табель',
    group_code: 'employee',
    group_label: 'Личный кабинет',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 60,
    is_active: true,
    is_system: true,
  },
  {
    key: '/employee/history',
    label: 'Моя история',
    group_code: 'employee',
    group_label: 'Личный кабинет',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 70,
    is_active: true,
    is_system: true,
  },
  {
    key: '/employee/salary-raise',
    label: 'Повышение оклада',
    group_code: 'employee',
    group_label: 'Личный кабинет',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 80,
    is_active: true,
    is_system: true,
  },
  {
    key: '/dashboard',
    label: 'Дашборд',
    group_code: 'operations',
    group_label: 'Управление',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 90,
    is_active: true,
    is_system: true,
  },
  {
    key: '/timesheet',
    label: 'Табель',
    group_code: 'operations',
    group_label: 'Управление',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 100,
    is_active: true,
    is_system: true,
  },
  {
    key: '/timesheet-hr',
    label: 'Табели HR',
    group_code: 'operations',
    group_label: 'Управление',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 110,
    is_active: true,
    is_system: true,
  },
  {
    key: '/leave-requests',
    label: 'Заявления',
    group_code: 'operations',
    group_label: 'Управление',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 120,
    is_active: true,
    is_system: true,
  },
  {
    key: '/salary-raise-review',
    label: 'Проверка заявок на повышение',
    group_code: 'operations',
    group_label: 'Управление',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 130,
    is_active: true,
    is_system: true,
  },
  {
    key: '/discipline',
    label: 'Дисциплина',
    group_code: 'operations',
    group_label: 'Управление',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 140,
    is_active: true,
    is_system: true,
  },
  {
    key: '/employees',
    label: 'Сотрудники',
    group_code: 'operations',
    group_label: 'Управление',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 150,
    is_active: true,
    is_system: true,
  },
  {
    key: '/staff-control',
    label: 'Управление кадрами',
    group_code: 'operations',
    group_label: 'Управление',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 160,
    is_active: true,
    is_system: true,
  },
  {
    key: '/skud-travel',
    label: 'Передвижения',
    group_code: 'skud',
    group_label: 'СКУД',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 170,
    is_active: true,
    is_system: true,
  },
  {
    key: '/skud-raw',
    label: 'Просмотр СКУД',
    group_code: 'skud',
    group_label: 'СКУД',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 180,
    is_active: true,
    is_system: true,
  },
  {
    key: '/skud-db',
    label: 'СКУД (база)',
    group_code: 'skud',
    group_label: 'СКУД',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 190,
    is_active: true,
    is_system: true,
  },
  {
    key: '/skud-monitor',
    label: 'Монитор Sigur',
    group_code: 'skud',
    group_label: 'СКУД',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 200,
    is_active: true,
    is_system: true,
  },
  {
    key: '/skud-settings',
    label: 'Настройки СКУД',
    group_code: 'skud',
    group_label: 'СКУД',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: false,
    requires_employee_variant: false,
    sort_order: 210,
    is_active: true,
    is_system: true,
  },
  {
    key: '/admin/users',
    label: 'Управление пользователями',
    group_code: 'admin',
    group_label: 'Администрирование',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: false,
    requires_employee_variant: false,
    sort_order: 220,
    is_active: true,
    is_system: true,
  },
  {
    key: '/admin/audit',
    label: 'Аудит данных',
    group_code: 'admin',
    group_label: 'Администрирование',
    surface: 'page',
    supports_edit: false,
    requires_data_scope: false,
    requires_employee_variant: false,
    sort_order: 230,
    is_active: true,
    is_system: true,
  },
  {
    key: '/admin/roles',
    label: 'Управление ролями',
    group_code: 'admin',
    group_label: 'Администрирование',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: false,
    requires_employee_variant: false,
    sort_order: 240,
    is_active: true,
    is_system: true,
  },
  {
    key: '/admin/settings',
    label: 'Системные настройки',
    group_code: 'admin',
    group_label: 'Администрирование',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: false,
    requires_employee_variant: false,
    sort_order: 250,
    is_active: true,
    is_system: true,
  },
  {
    key: '/admin/schedules',
    label: 'Графики работы',
    group_code: 'admin',
    group_label: 'Администрирование',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: false,
    requires_employee_variant: false,
    sort_order: 260,
    is_active: true,
    is_system: true,
  },
  {
    key: '/admin/payslips',
    label: 'Управление расчётными листками',
    group_code: 'admin',
    group_label: 'Администрирование',
    surface: 'page',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 270,
    is_active: true,
    is_system: true,
  },
  {
    key: '/admin/payments',
    label: 'Управление выплатами',
    group_code: 'technical',
    group_label: 'Технические доступы',
    surface: 'technical',
    supports_edit: true,
    requires_data_scope: true,
    requires_employee_variant: false,
    sort_order: 280,
    is_active: true,
    is_system: true,
  },
];

export function normalizePermissions(permissions: string[] | null | undefined): string[] {
  return [...new Set((permissions || []).filter(Boolean))].sort();
}

export function normalizePageAccessEntry<T extends PageAccessEntry>(entry: T): T {
  if (entry.can_edit && !entry.can_view) {
    return { ...entry, can_view: true };
  }

  return entry;
}

export function accessModeFromFlags(input: { can_view?: boolean; can_edit?: boolean } | null | undefined): AccessMode {
  if (input?.can_edit) return 'edit';
  if (input?.can_view) return 'view';
  return 'none';
}

export function accessModeToFlags(mode: AccessMode): { can_view: boolean; can_edit: boolean } {
  if (mode === 'edit') {
    return { can_view: true, can_edit: true };
  }

  if (mode === 'view') {
    return { can_view: true, can_edit: false };
  }

  return { can_view: false, can_edit: false };
}

function countByPrefix(permissions: string[], prefix: string): number {
  return permissions.filter((permission) => permission.startsWith(prefix)).length;
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

export function validatePermissionSelections(roleCode: string, permissions: string[] | null | undefined): string | null {
  const normalized = normalizePermissions(permissions);
  const variantCount = countByPrefix(normalized, EMPLOYEE_VARIANT_PREFIX);
  const dataScopeCount = countByPrefix(normalized, DATA_SCOPE_PREFIX);

  if (variantCount > 1) {
    return `Роль ${roleCode}: можно выбрать только один вариант кабинета /employee`;
  }

  if (dataScopeCount > 1) {
    return `Роль ${roleCode}: можно выбрать только одну область данных`;
  }

  return null;
}
