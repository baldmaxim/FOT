export type AccessAction = 'view' | 'edit';
export type AccessMode = 'none' | 'view' | 'edit';
export type AccessPageSurface = 'page' | 'technical';
/** Область права: личный кабинет сотрудника или админка. */
export type AccessPageArea = 'personal' | 'admin';
export type DataScope = 'self' | 'department' | 'all';

export interface PageCatalogItem {
  key: string;
  label: string;
  group_code: string;
  group_label: string;
  area: AccessPageArea;
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

/**
 * Тип-сейфтные константы путей страниц. Используются как единый источник
 * для DEFAULT_ACCESS_PAGE_CATALOG ниже, а также могут импортироваться из
 * routes/* и других мест вместо string-литералов.
 *
 * Контракт-тест `access-page-catalog-contract.test.ts` следит за тем, чтобы
 * каждый PAGE_PATHS.* присутствовал в каталоге и использовался либо во
 * фронте, либо в защите бэкенд-роутов.
 */
export const PAGE_PATHS = {
  EMPLOYEE: '/employee',
  EMPLOYEE_REQUESTS: '/employee/requests',
  EMPLOYEE_DOCUMENTS: '/employee/documents',
  EMPLOYEE_TASKS: '/employee/tasks',
  EMPLOYEE_SALARY_RAISE: '/employee/salary-raise',
  EMPLOYEE_SIM: '/employee/sim',
  EMPLOYEE_PHONEBOOK: '/employee/phonebook',
  EMPLOYEE_FEEDBACK: '/employee/feedback',
  FEEDBACK_REVIEW: '/feedback-review',
  DASHBOARD: '/dashboard',
  TIMESHEET: '/timesheet',
  TIMESHEET_HR: '/timesheet-hr',
  LEAVE_REQUESTS: '/leave-requests',
  LEAVE_VACATIONS: '/leave-vacations',
  SALARY_RAISE_REVIEW: '/salary-raise-review',
  DISCIPLINE: '/discipline',
  STAFF_CONTROL: '/staff-control',
  STAFF_CONTROL_HIRING: '/staff-control/hiring',
  STAFF_CONTROL_DEPARTMENT: '/staff-control/department',
  STAFF_CONTROL_POSITION: '/staff-control/position',
  STAFF_CONTROL_SCHEDULE: '/staff-control/schedule',
  EMPLOYEES_CARD: '/employees',
  TIMESHEET_EVENTS: '/timesheet/events',
  SKUD_SETTINGS: '/skud-settings',
  SKUD_CARD_READER: '/skud-card-reader',
  MTS: '/mts',
  MTS_BUSINESS: '/mts-business',
  SKUD_PRESENCE: '/skud-presence',
  CONTRACTOR: '/contractor',
  ADMIN_CONTRACTOR_APPROVALS: '/admin/contractor-approvals',
  ADMIN_CONTRACTOR_APPROVALS_SUBMISSIONS: '/admin/contractor-approvals/submissions',
  ADMIN_CONTRACTOR_APPROVALS_OTITB: '/admin/contractor-approvals/otitb',
  ADMIN_USERS: '/admin/users',
  ADMIN_AUDIT: '/admin/audit',
  ADMIN_ACTION_HISTORY: '/admin/action-history',
  ADMIN_ROLES: '/admin/roles',
  ADMIN_SETTINGS: '/admin/settings',
  ADMIN_SCHEDULES: '/admin/schedules',
  ADMIN_SCHEDULES_TEMPLATES: '/admin/schedules/templates',
  ADMIN_PAYSLIPS: '/admin/payslips',
  ADMIN_PATENT_RECEIPTS: '/admin/patent-receipts',
  ADMIN_TIMESHEET_TRANSFERS: '/admin/timesheet-transfers',
  ADMIN_DATA_API: '/admin/data-api',
  ADMIN_CHECKS: '/admin/checks',
  TIMESHEET_TEAM_MANAGEMENT: 'timesheet-team-management',
} as const;

export type PagePath = typeof PAGE_PATHS[keyof typeof PAGE_PATHS];

// Каталог зеркалит боковое меню (fot-app/src/components/layout/navConfig.ts) и делится
// на две области: `personal` — личный кабинет сотрудника, `admin` — админка (блоки
// «Обзор и заявления» / «Управление» / «Администрирование» + свёрнутые «Технические доступы»).
// key/surface/supports_edit неизменны (используются route-гардами и контракт-тестом).
export const DEFAULT_ACCESS_PAGE_CATALOG: PageCatalogItem[] = [
  // ── Личный кабинет ──
  { key: '/employee',                   label: 'Личный кабинет',                       group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: false, sort_order: 10,  is_active: true },
  { key: '/employee/requests',          label: 'Мои заявления',                        group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: true,  sort_order: 11,  is_active: true },
  { key: '/employee/documents',         label: 'Мои документы',                        group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: true,  sort_order: 12,  is_active: true },
  { key: '/employee/tasks',             label: 'Мои задачи',                           group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: true,  sort_order: 13,  is_active: true },
  { key: '/employee/salary-raise',      label: 'Повышение оклада',                     group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: true,  sort_order: 14,  is_active: true },
  { key: '/employee/sim',               label: 'Моя SIM',                              group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: true,  sort_order: 15,  is_active: true },
  { key: '/employee/phonebook',         label: 'Телефонная книга',                     group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: false, sort_order: 16,  is_active: true },
  { key: '/employee/feedback',          label: 'Обратная связь',                       group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: true,  sort_order: 17,  is_active: true },
  { key: '/contractor',                 label: 'Кабинет подрядчика: пропуска',         group_code: 'lk',    group_label: 'Личный кабинет',       area: 'personal', surface: 'page',      supports_edit: true,  sort_order: 18,  is_active: true },
  // ── Админка: обзор и заявления ──
  { key: '/dashboard',                  label: 'Обзор',                                group_code: 'overview', group_label: 'Обзор и заявления', area: 'admin',    surface: 'page',      supports_edit: false, sort_order: 20,  is_active: true },
  { key: '/leave-requests',             label: 'Заявления',                            group_code: 'overview', group_label: 'Обзор и заявления', area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 30,  is_active: true },
  { key: '/salary-raise-review',        label: 'Заявления — Проверка повышений оклада', group_code: 'overview', group_label: 'Обзор и заявления', area: 'admin',   surface: 'page',      supports_edit: true,  sort_order: 31,  is_active: true },
  { key: '/leave-vacations',            label: 'Заявления — Отпуска (отдел кадров)',   group_code: 'overview', group_label: 'Обзор и заявления', area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 32,  is_active: true },
  { key: '/skud-presence',              label: 'Сотрудники на объектах',               group_code: 'overview', group_label: 'Обзор и заявления', area: 'admin',    surface: 'page',      supports_edit: false, sort_order: 40,  is_active: true },
  // ── Админка: управление ──
  { key: '/staff-control',              label: 'Управление кадрами',                   group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 100, is_active: true },
  { key: '/timesheet',                  label: 'Табель',                               group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 110, is_active: true },
  { key: '/timesheet/events',           label: 'Табель — события СКУД (вкладка дня)',  group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'technical', supports_edit: false, sort_order: 115, is_active: true },
  { key: '/timesheet-hr',               label: 'Согласования / Табели HR',             group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 120, is_active: true },
  { key: '/discipline',                 label: 'Аналитика',                            group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'page',      supports_edit: false, sort_order: 130, is_active: true },
  { key: '/feedback-review',            label: 'Обратная связь (разбор)',              group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 131, is_active: true },
  { key: '/employees',                  label: 'Карточка сотрудника',                  group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'page',      supports_edit: false, sort_order: 140, is_active: true },
  { key: '/staff-control/hiring',       label: 'Управление кадрами — Заявки на поиск сотрудников',   group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'page',      supports_edit: false, sort_order: 105, is_active: true },
  { key: '/staff-control/department',   label: 'Управление кадрами — смена отдела',    group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'technical', supports_edit: true,  sort_order: 161, is_active: true },
  { key: '/staff-control/position',     label: 'Управление кадрами — смена должности', group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'technical', supports_edit: true,  sort_order: 162, is_active: true },
  { key: '/staff-control/schedule',     label: 'Управление кадрами — смена графика',   group_code: 'work',  group_label: 'Управление',           area: 'admin',    surface: 'technical', supports_edit: true,  sort_order: 163, is_active: true },
  // ── Админка: администрирование ──
  { key: '/admin/schedules',            label: 'Графики работы',                       group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 200, is_active: true },
  { key: '/admin/schedules/templates',  label: 'Графики работы — шаблоны (вкладка)',   group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'technical', supports_edit: true,  sort_order: 205, is_active: true },
  { key: '/admin/patent-receipts',      label: 'Чеки за патент',                       group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 210, is_active: true },
  { key: '/admin/timesheet-transfers',  label: 'Переводы и исключения',                group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 220, is_active: true },
  { key: '/skud-settings',              label: 'СКУД',                                 group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 230, is_active: true },
  { key: '/skud-card-reader',           label: 'Пропуск',                              group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 240, is_active: true },
  { key: '/mts',                        label: 'Мобильные сотрудники МТС',             group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 245, is_active: true },
  { key: '/mts-business',               label: 'МТС Бизнес — звонки',                  group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 246, is_active: true },
  { key: '/admin/contractor-approvals', label: 'Подрядчики',                           group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 242, is_active: true },
  { key: '/admin/contractor-approvals/submissions', label: 'Подрядчики — Заявки на согласование (вкладка)', group_code: 'admin', group_label: 'Администрирование', area: 'admin', surface: 'technical', supports_edit: true, sort_order: 243, is_active: true },
  { key: '/admin/contractor-approvals/otitb',       label: 'Подрядчики — ОТиТБ (вкладка)',                  group_code: 'admin', group_label: 'Администрирование', area: 'admin', surface: 'technical', supports_edit: true, sort_order: 244, is_active: true },
  { key: '/admin/users',                label: 'Система — Управление пользователями',  group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 250, is_active: true },
  { key: '/admin/roles',                label: 'Система — Управление ролями',          group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 251, is_active: true },
  { key: '/admin/audit',                label: 'Система — Аудит данных',               group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: false, sort_order: 252, is_active: true },
  { key: '/admin/action-history',       label: 'Система — История действий',           group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: false, sort_order: 253, is_active: true },
  { key: '/admin/settings',             label: 'Система — Системные настройки',        group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 254, is_active: true },
  { key: '/admin/data-api',             label: 'Система — API-доступ к данным',        group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 255, is_active: true },
  { key: '/admin/checks',               label: 'Система — Проверки (РКЛ / Патент)',    group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 256, is_active: true },
  { key: '/admin/payslips',             label: 'Управление расчётными листками',       group_code: 'admin', group_label: 'Администрирование',    area: 'admin',    surface: 'page',      supports_edit: true,  sort_order: 260, is_active: true },
  // Технический ключ без route-страницы
  { key: 'timesheet-team-management',   label: 'Управление составом табеля',           group_code: 'technical', group_label: 'Технические доступы', area: 'admin',  surface: 'technical', supports_edit: true, sort_order: 285, is_active: true },
];

/**
 * Ключи личного кабинета: право остаётся у роли даже при выключенном
 * system_roles.admin_access. Всё остальное — админка (см. `area` в каталоге).
 *
 * `/contractor` — личный кабинет подрядчика (не админ-раздел), поэтому тоже
 * personal: иначе роль подрядчика без admin_access потеряла бы свой кабинет.
 * Префикс `/employee` намеренно сверяется точно — `/employees` («Карточка
 * сотрудника») это уже админка.
 */
export const isPersonalPageKey = (key: string): boolean =>
  key === PAGE_PATHS.EMPLOYEE
  || key.startsWith('/employee/')
  || key === PAGE_PATHS.CONTRACTOR;

export const isAdminAreaPageKey = (key: string): boolean => !isPersonalPageKey(key);

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
