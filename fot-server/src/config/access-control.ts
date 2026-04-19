export type AccessAction = 'view' | 'edit';
export type AccessMode = 'none' | 'view' | 'edit';
export type AccessPageSurface = 'page' | 'technical';
export type DataScope = 'self' | 'department' | 'all';

export interface PageCatalogItem {
  key: string;
  label: string;
  group_code: string;
  group_label: string;
  surface: AccessPageSurface;
  supports_edit: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface PageAccessEntry {
  role_code: string;
  page_path: string;
  can_view: boolean;
  can_edit: boolean;
}

export const CRITICAL_ADMIN_PAGE_KEYS = ['/admin/roles', '/admin/users'] as const;

export const DEFAULT_ACCESS_PAGE_CATALOG: PageCatalogItem[] = [
  { key: '/employee',                   label: 'Личный кабинет',                 group_code: 'employee', group_label: 'Личный кабинет',       surface: 'page',      supports_edit: false, sort_order: 10,  is_active: true },
  { key: '/employee/requests',          label: 'Мои заявления',                  group_code: 'employee', group_label: 'Личный кабинет',       surface: 'page',      supports_edit: true,  sort_order: 20,  is_active: true },
  { key: '/employee/payslips',          label: 'Расчётные листки',               group_code: 'employee', group_label: 'Личный кабинет',       surface: 'page',      supports_edit: false, sort_order: 30,  is_active: true },
  { key: '/employee/payments',          label: 'История выплат',                 group_code: 'employee', group_label: 'Личный кабинет',       surface: 'page',      supports_edit: false, sort_order: 40,  is_active: true },
  { key: '/employee/documents',         label: 'Мои документы',                  group_code: 'employee', group_label: 'Личный кабинет',       surface: 'page',      supports_edit: true,  sort_order: 50,  is_active: true },
  { key: '/employee/timesheet',         label: 'Мой табель',                     group_code: 'employee', group_label: 'Личный кабинет',       surface: 'page',      supports_edit: true,  sort_order: 60,  is_active: true },
  { key: '/employee/history',           label: 'Моя история',                    group_code: 'employee', group_label: 'Личный кабинет',       surface: 'page',      supports_edit: false, sort_order: 70,  is_active: true },
  { key: '/employee/salary-raise',      label: 'Повышение оклада',               group_code: 'employee', group_label: 'Личный кабинет',       surface: 'page',      supports_edit: true,  sort_order: 80,  is_active: true },
  { key: '/dashboard',                  label: 'Дашборд',                        group_code: 'ops',      group_label: 'Управление',           surface: 'page',      supports_edit: false, sort_order: 90,  is_active: true },
  { key: '/timesheet',                  label: 'Табель',                         group_code: 'ops',      group_label: 'Управление',           surface: 'page',      supports_edit: true,  sort_order: 100, is_active: true },
  { key: '/timesheet-hr',               label: 'Табели HR',                      group_code: 'ops',      group_label: 'Управление',           surface: 'page',      supports_edit: true,  sort_order: 110, is_active: true },
  { key: '/leave-requests',             label: 'Заявления',                      group_code: 'ops',      group_label: 'Управление',           surface: 'page',      supports_edit: true,  sort_order: 120, is_active: true },
  { key: '/salary-raise-review',        label: 'Проверка заявок на повышение',   group_code: 'ops',      group_label: 'Управление',           surface: 'page',      supports_edit: true,  sort_order: 130, is_active: true },
  { key: '/discipline',                 label: 'Дисциплина',                     group_code: 'ops',      group_label: 'Управление',           surface: 'page',      supports_edit: false, sort_order: 140, is_active: true },
  { key: '/employees',                  label: 'Сотрудники',                     group_code: 'ops',      group_label: 'Управление',           surface: 'page',      supports_edit: true,  sort_order: 150, is_active: true },
  { key: '/staff-control',              label: 'Управление кадрами',             group_code: 'ops',      group_label: 'Управление',           surface: 'page',      supports_edit: true,  sort_order: 160, is_active: true },
  { key: '/skud-travel',                label: 'Передвижения',                   group_code: 'skud',     group_label: 'СКУД',                 surface: 'page',      supports_edit: true,  sort_order: 170, is_active: true },
  { key: '/skud-raw',                   label: 'Просмотр СКУД',                  group_code: 'skud',     group_label: 'СКУД',                 surface: 'page',      supports_edit: false, sort_order: 180, is_active: true },
  { key: '/skud-db',                    label: 'СКУД (база)',                    group_code: 'skud',     group_label: 'СКУД',                 surface: 'page',      supports_edit: false, sort_order: 190, is_active: true },
  { key: '/skud-monitor',               label: 'Монитор Sigur',                  group_code: 'skud',     group_label: 'СКУД',                 surface: 'page',      supports_edit: false, sort_order: 200, is_active: true },
  { key: '/skud-settings',              label: 'Настройки СКУД',                 group_code: 'skud',     group_label: 'СКУД',                 surface: 'page',      supports_edit: true,  sort_order: 210, is_active: true },
  { key: '/admin/users',                label: 'Управление пользователями',      group_code: 'admin',    group_label: 'Администрирование',    surface: 'page',      supports_edit: true,  sort_order: 220, is_active: true },
  { key: '/admin/audit',                label: 'Аудит данных',                   group_code: 'admin',    group_label: 'Администрирование',    surface: 'page',      supports_edit: false, sort_order: 230, is_active: true },
  { key: '/admin/roles',                label: 'Управление ролями',              group_code: 'admin',    group_label: 'Администрирование',    surface: 'page',      supports_edit: true,  sort_order: 240, is_active: true },
  { key: '/admin/settings',             label: 'Системные настройки',            group_code: 'admin',    group_label: 'Администрирование',    surface: 'page',      supports_edit: true,  sort_order: 250, is_active: true },
  { key: '/admin/schedules',            label: 'Графики работы',                 group_code: 'admin',    group_label: 'Администрирование',    surface: 'page',      supports_edit: true,  sort_order: 260, is_active: true },
  { key: '/admin/payslips',             label: 'Управление расчётными листками', group_code: 'admin',    group_label: 'Администрирование',    surface: 'page',      supports_edit: true,  sort_order: 270, is_active: true },
  { key: '/admin/payments',             label: 'Управление выплатами',           group_code: 'technical', group_label: 'Технические доступы', surface: 'technical', supports_edit: true,  sort_order: 280, is_active: true },
  { key: '/employees/structure-manage', label: 'Управление деревом отделов',     group_code: 'technical', group_label: 'Технические доступы', surface: 'technical', supports_edit: true,  sort_order: 282, is_active: true },
  { key: '/timesheet/team-management',  label: 'Управление составом табеля',     group_code: 'technical', group_label: 'Технические доступы', surface: 'technical', supports_edit: true,  sort_order: 285, is_active: true },
];

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
  if (mode === 'edit') return { can_view: true, can_edit: true };
  if (mode === 'view') return { can_view: true, can_edit: false };
  return { can_view: false, can_edit: false };
}
