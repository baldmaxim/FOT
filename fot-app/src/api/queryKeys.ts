/**
 * Централизованные query-key factories для React Query.
 *
 * Используем иерархические ключи: `[domain, entity, ...filters]` — это позволяет
 * инвалидировать целый домен (`queryClient.invalidateQueries({ queryKey: timesheetKeys.all })`)
 * либо точечный subset (`{ queryKey: timesheetKeys.page(month, dept) }`).
 *
 * При добавлении нового домена/подзапроса:
 *   1) экспортируйте factory тут;
 *   2) импортируйте его в хук/компонент вместо string-литерала;
 *   3) для invalidate — выбирайте максимально широкий ключ, чтобы не забыть подзапросы.
 *
 * Постепенная миграция: оставшиеся inline-keys можно мигрировать по одному файлу
 * по мере правок. Контракт-тесты тут не требуются — TypeScript обеспечивает безопасность.
 */

// ─── Employees ─────────────────────────────────────────────────────────────

export const employeesKeys = {
  all: ['employees'] as const,
  counts: (archived: boolean) => [...employeesKeys.all, 'counts', archived ? 'archived' : 'active'] as const,
  paginated: (params: Record<string, unknown>) => [...employeesKeys.all, 'paginated', params] as const,
  byId: (employeeId: number | string) => [...employeesKeys.all, 'detail', employeeId] as const,
  departmentAccess: () => ['admin-employees', 'department-access'] as const,
  departmentImport: () => ['admin-users', 'department-import', 'employees'] as const,
};

// ─── Presence (СКУД онлайн) ────────────────────────────────────────────────

export const presenceKeys = {
  all: ['presence'] as const,
  byDepartment: (departmentId?: string | null) => [...presenceKeys.all, departmentId || 'all'] as const,
};

// ─── Dashboard ─────────────────────────────────────────────────────────────

export const dashboardKeys = {
  all: ['dashboard'] as const,
  stats: (departmentId: string | null, period: string, month?: string) =>
    [...dashboardKeys.all, 'stats', departmentId, period, month ?? null] as const,
};

// ─── Timesheet ─────────────────────────────────────────────────────────────
//
// Несколько связанных подключей: page (основной экран), hr (HR-вид), grid (грид),
// overview (агрегация), approval (статусы согласований), corrections, transfers.
// Инвалидация after-mutation — `timesheetKeys.all` чтобы тронуть всё.

export const timesheetKeys = {
  all: ['timesheet'] as const,
  page: (...filters: unknown[]) => [...timesheetKeys.all, 'page', ...filters] as const,
  hr: (...filters: unknown[]) => ['timesheet-hr', ...filters] as const,
  grid: (...filters: unknown[]) => ['timesheet-grid', ...filters] as const,
  overview: (...filters: unknown[]) => ['timesheet-overview', ...filters] as const,
  approval: (...filters: unknown[]) => ['timesheet-approval', ...filters] as const,
  corrections: (...filters: unknown[]) => ['timesheet-corrections', ...filters] as const,
  transfers: (departmentId?: string | null) => ['timesheet-transfers', departmentId ?? null] as const,
  adminTransfers: (...filters: unknown[]) => ['admin-timesheet-transfers', ...filters] as const,
  travelDaySegments: (employeeId: number | string, workDate: string) =>
    ['travel-day-segments', employeeId, workDate] as const,
};

/**
 * Список верхне-уровневых ключей всех «семей» табеля.
 * Инвалидация мутаций табеля: пройти `for (const k of TIMESHEET_FAMILY_KEYS)`.
 */
export const TIMESHEET_FAMILY_KEYS = [
  timesheetKeys.all,
  ['timesheet-hr'] as const,
  ['timesheet-grid'] as const,
  ['timesheet-overview'] as const,
  ['timesheet-approval'] as const,
  ['timesheet-corrections'] as const,
  ['timesheet-transfers'] as const,
  ['admin-timesheet-transfers'] as const,
  ['timesheet-page'] as const,
];

// ─── Sigur Admin (СКУД admin) ──────────────────────────────────────────────

export const SIGUR_ADMIN_QUERY_KEY = ['sigur-admin'] as const;

export const sigurAdminKeys = {
  all: SIGUR_ADMIN_QUERY_KEY,
  departmentsTree: () => [...SIGUR_ADMIN_QUERY_KEY, 'departments-tree'] as const,
  positions: () => [...SIGUR_ADMIN_QUERY_KEY, 'positions'] as const,
  employeeSuggestions: (query: string) => [...SIGUR_ADMIN_QUERY_KEY, 'employee-suggestions', query] as const,
  employees: (...filters: unknown[]) => [...SIGUR_ADMIN_QUERY_KEY, 'employees', ...filters] as const,
  employeeCardStatuses: (idsKey: string) => [...SIGUR_ADMIN_QUERY_KEY, 'employee-card-statuses', idsKey] as const,
};

// ─── Sigur Header / Connection ──────────────────────────────────────────────

export const sigurHeaderKeys = {
  all: ['sigur-header'] as const,
  connectionStatus: () => [...sigurHeaderKeys.all, 'connection-status'] as const,
  employeesTotal: () => [...sigurHeaderKeys.all, 'employees-total'] as const,
};

export const sigurKeys = {
  all: ['sigur'] as const,
  syncFilter: () => [...sigurKeys.all, 'sync-filter'] as const,
};

// ─── Structure (org_departments + positions) ───────────────────────────────

export const structureKeys = {
  all: ['structure'] as const,
};

// ─── Roles & Admin ─────────────────────────────────────────────────────────

export const rolesKeys = {
  all: ['admin-roles'] as const,
  full: () => ['admin-roles-full'] as const,
};

// ─── Settings ──────────────────────────────────────────────────────────────

export const settingsKeys = {
  openRouter: () => ['openrouter-settings'] as const,
};

// ─── Patent Receipts ───────────────────────────────────────────────────────

export const patentReceiptsKeys = {
  all: ['patent-receipts'] as const,
  byId: (receiptId: string | number) => ['patent-receipt', receiptId] as const,
};

// ─── KPI закрытия КС-2 (объекты строительства) ─────────────────────────────

export const objectKpiKeys = {
  all: ['object-kpi'] as const,
  objects: () => [...objectKpiKeys.all, 'objects'] as const,
  // objectId в ключе обязателен: сервер сужает отчёт по object_id, и без него кэш
  // отдал бы данные всех объектов под видом выбранного.
  report: (from: string, to: string, objectId: string = 'all') =>
    [...objectKpiKeys.all, 'report', from, to, objectId] as const,
  // Окно считает сервер — дат в ключе нет, объект обязателен.
  reportAuto: (objectId: string) => [...objectKpiKeys.all, 'report-auto', objectId] as const,
  reportSummary: (objectId: string) => [...objectKpiKeys.all, 'report-summary', objectId] as const,
  // Окно в ключе обязательно: премия считается за конкретный период, а не «вообще».
  reportPremium: (from: string, to: string, objectId: string) =>
    [...objectKpiKeys.all, 'report-premium', from, to, objectId] as const,
  headcount: (from: string, to: string) => [...objectKpiKeys.all, 'headcount', from, to] as const,
  card: (objectId: string, from: string, to: string) =>
    [...objectKpiKeys.all, 'card', objectId, from, to] as const,
  history: (objectId: string) => [...objectKpiKeys.all, 'history', objectId] as const,
  assignments: (objectId?: string) => [...objectKpiKeys.all, 'assignments', objectId ?? 'all'] as const,
  globalRoles: () => [...objectKpiKeys.all, 'global-roles'] as const,
  fixationInfo: (month: string) => [...objectKpiKeys.all, 'fixation-info', month] as const,
  myObjects: (from: string, to: string) => [...objectKpiKeys.all, 'my-objects', from, to] as const,
};
