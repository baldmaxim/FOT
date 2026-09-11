import { Router, type Request } from 'express';
import { adminController } from '../controllers/admin.controller.js';
import { adminSystemResourcesController } from '../controllers/admin-system-resources.controller.js';
import { timesheetModeController } from '../controllers/timesheet-mode.controller.js';
import { authenticate, requireAnyPageAccess, requireCritical2FA, requirePageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';
import { noStore } from '../middleware/noStore.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

router.use(authenticate);

// Per-user кеш списка пользователей. company_scope ленивая (резолвится внутри
// filterUsersByCompanyScope в самом контроллере), поэтому в keyFn её ещё нет —
// используем per-userId ключ. Это безопасно: scope админа стабилен в рамках
// одной сессии (изменения в user_company_access => перелогин), и любая мутация
// /users/* инвалидирует кеш ниже. SWR-окно даёт мгновенный повторный ответ.
const usersListCache = registerCache(
  'admin:users:list',
  (req: Request) => {
    const userId = (req as AuthenticatedRequest).user?.id ?? 'anon';
    const q = req.query;
    let variant: string;
    if (q.countOnly === '1') {
      variant = 'count';
    } else if (q.slim === '1') {
      variant = 'slim';
    } else if (q.page !== undefined) {
      const search = ((q.search as string) || '').trim().toLowerCase();
      variant = `p:${q.page}:${q.pageSize ?? ''}:${search}:${q.role ?? ''}`;
    } else {
      variant = 'legacy';
    }
    return `users:${userId}:${variant}`;
  },
  30_000,
  { staleMs: 60_000, max: 200 },
);

const pendingUsersCache = registerCache(
  'admin:users:pending',
  (req: Request) => `pending:${(req as AuthenticatedRequest).user?.id ?? 'anon'}`,
  30_000,
  { staleMs: 60_000, max: 200 },
);

const passwordResetRequestsCache = registerCache(
  'admin:users:password-reset-requests',
  (req: Request) => `prr:${(req as AuthenticatedRequest).user?.id ?? 'anon'}`,
  30_000,
  { staleMs: 60_000, max: 50 },
);

// Write-through invalidation: после успешной мутации /users/* или
// /employees/.../department-access сбрасываем оба кеша. Регистронезависимо
// проверяем /skud-objects и /companies — они тоже могут изменить агрегаты,
// которые возвращает /admin/users (привязки сотрудников, компании админа).
router.use((req, res, next) => {
  const isMutation = req.method !== 'GET' && req.method !== 'HEAD';
  if (!isMutation) {
    next();
    return;
  }
  const p = req.path;
  const touchesUsers = p.startsWith('/users')
    || p.startsWith('/employees/')
    || p.startsWith('/companies');
  if (!touchesUsers) {
    next();
    return;
  }
  // Инвалидируем СИНХРОННО, до отправки тела ответа: иначе клиент сразу
  // после мутации шлёт refetch GET, который на low-latency (localhost/dev)
  // успевает прочитать ещё не очищенный кеш (res.on('finish') выполняется
  // уже после flush). Перехват res.json гарантирует clear до того, как
  // клиент получит ответ и инициирует refetch. finish — fallback для
  // редких не-json 2xx ответов (повторный clear идемпотентен).
  const invalidateOnSuccess = () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      invalidateCaches('admin:users:list', 'admin:users:pending', 'admin:users:password-reset-requests');
    }
  };
  const originalJson = res.json.bind(res);
  res.json = (body: object) => {
    invalidateOnSuccess();
    return originalJson(body);
  };
  res.on('finish', invalidateOnSuccess);
  next();
});

// Пользователи — доступно admin.
// noStore: глобальный дефолт `private, max-age=30` (app.ts) держал у браузера
// тело списка, снятое ДО мутации — после удаления пользователя рефетч читал
// ответ из HTTP-кеша, строка «возвращалась», и админ жал «Удалить» повторно,
// хотя в БД он уже удалён с первого раза. Серверный LRU-кеш ниже остаётся.
// Заодно списки с ПДн (ФИО, email) перестают оседать в кеше браузера.
// Раздел «Пользователи» разбит на два ключа (миграция 270):
//   /admin/users        — работа с учётной записью: очередь заявок, одобрение,
//                         отклонение, удаление, email, сброс пароля, ФИО, привязка
//                         карточки СКУД;
//   /admin/users/access — настройка ЧУЖИХ прав: роль пользователя, отделы, объекты,
//                         скоуп табельщицы, компании администратора, чужая 2FA.
// Второй ключ критичный (CRITICAL_ADMIN_PAGE_KEYS) — снять его у последней роли нельзя.
router.get('/users', requirePageAccess('/admin/users', 'view'), noStore, usersListCache, adminController.getAllUsers);
router.get('/users/pending', requirePageAccess('/admin/users', 'view'), noStore, pendingUsersCache, adminController.getPendingUsers);
// Запросы на сброс пароля — должен быть выше /users/:id/..., иначе Express
// смэтчит как `:id = 'password-reset-requests'`.
router.get(
  '/users/password-reset-requests',
  requirePageAccess('/admin/users', 'view'),
  noStore,
  passwordResetRequestsCache,
  adminController.getPasswordResetRequests,
);
// Чёрный список (миграция 273). Объявлен ВЫШЕ /users/:id/..., иначе Express
// смэтчит как `:id = 'blacklist'` (та же причина, что у password-reset-requests).
// DELETE намеренно не используем — конфликтовал бы с DELETE /users/:id.
router.get('/users/blacklist', requirePageAccess('/admin/users', 'view'), noStore, adminController.listBlacklist);
router.get('/users/blacklist/persons', requirePageAccess('/admin/users', 'view'), noStore, adminController.searchPersons);
router.post('/users/blacklist/resolve', requirePageAccess('/admin/users', 'view'), adminController.resolveTargets);
router.post('/users/blacklist', requirePageAccess('/admin/users', 'edit'), requireCritical2FA, adminController.addEntry);
router.post('/users/blacklist/:entryId/remove', requirePageAccess('/admin/users', 'edit'), requireCritical2FA, adminController.removeEntry);
router.post('/users/blacklist/:entryId/retry-sigur', requirePageAccess('/admin/users', 'edit'), requireCritical2FA, adminController.retrySigur);

// Список назначений читают оба: администратор доступов и тот, кто ведёт только
// прямых подчинённых (кадровый админ) — без него экран «Прямые подчинённые» пуст.
router.get('/employees/department-access', requireAnyPageAccess(['/admin/users/access', '/staff-control/direct-reports'], 'view'), adminController.getEmployeeDepartmentAssignments);
// Обратное представление: по бригаде/отделу — назначенные на неё сотрудники с должностями.
router.get('/departments/:id/assigned-employees', requireAnyPageAccess(['/admin/users/access', '/staff-control/direct-reports'], 'view'), adminController.getDepartmentAssignedEmployees);
router.post('/users/:id/approve', requirePageAccess('/admin/users', 'edit'), adminController.approveUser);
router.post('/users/:id/reject', requirePageAccess('/admin/users', 'edit'), adminController.rejectUser);
router.delete('/users/:id', requirePageAccess('/admin/users', 'edit'), adminController.deleteUser);
router.post('/users/:id/confirm-email', requirePageAccess('/admin/users', 'edit'), adminController.confirmUserEmail);
router.post('/users/:id/reset-link', requirePageAccess('/admin/users', 'edit'), adminController.generatePasswordResetLink);
router.get('/users/:id/peek', requirePageAccess('/admin/users', 'view'), adminController.peekUser);
router.patch('/users/:id/position', requirePageAccess('/admin/users/access', 'edit'), adminController.updateUserPosition);
router.patch('/users/:id/name', requirePageAccess('/admin/users', 'edit'), adminController.updateUserName);
router.patch('/users/:id/chat-inbound-mode', requirePageAccess('/admin/users', 'edit'), adminController.updateUserChatInboundMode);
router.patch('/users/:id/employee', requirePageAccess('/admin/users', 'edit'), adminController.updateUserEmployee);
router.put('/users/:id/department-access', requirePageAccess('/admin/users/access', 'edit'), adminController.updateUserDepartmentAccess);
router.put('/employees/:id/department-access', requirePageAccess('/admin/users/access', 'edit'), adminController.updateEmployeeDepartmentAccess);

// Приписка сотрудника к объектам строительства (миграция 092).
router.get('/skud-objects', requirePageAccess('/admin/users/access', 'view'), adminController.listSkudObjectsForAssignment);
router.get('/employees/:id/skud-objects', requirePageAccess('/admin/users/access', 'view'), adminController.getEmployeeSkudObjects);
router.put('/employees/:id/skud-objects', requirePageAccess('/admin/users/access', 'edit'), adminController.updateEmployeeSkudObjectAccess);

// Начальник участка — это роль site_supervisor (миграция 133); прямые назначения сотрудников ниже (миграция 090).
router.put('/users/:id/employee-access', requirePageAccess('/admin/users/access', 'edit'), adminController.updateUserEmployeeAccess);

// Назначение «объектов входа» сущностям для скоупа табельщицы (миграция 150).
router.get('/object-assignments', requirePageAccess('/admin/users/access', 'view'), adminController.getObjectAssignments);
router.put('/departments/:id/object-assignment', requirePageAccess('/admin/users/access', 'edit'), adminController.updateDepartmentObjectAssignment);
router.put('/employees/:id/object-assignment', requirePageAccess('/admin/users/access', 'edit'), adminController.updateEmployeeObjectAssignment);
// Режим табелирования для «Единого файла 1С» (миграция 249). Отдельное право:
// назначения объектов выше — админская функция, а режим правит ещё и HR.
router.get('/timesheet-modes', requirePageAccess('/staff-control/timesheet-mode', 'view'), timesheetModeController.list);
router.get('/timesheet-modes/departments', requirePageAccess('/staff-control/timesheet-mode', 'view'), timesheetModeController.listDepartments);
router.put('/timesheet-modes/departments', requirePageAccess('/staff-control/timesheet-mode', 'edit'), timesheetModeController.updateDepartmentsBulk);
router.put('/timesheet-modes/employees/:id', requirePageAccess('/staff-control/timesheet-mode', 'edit'), timesheetModeController.updateEmployee);
router.put('/timesheet-modes/departments/:id', requirePageAccess('/staff-control/timesheet-mode', 'edit'), timesheetModeController.updateDepartment);

router.get('/users/:id/timekeeper-objects', requirePageAccess('/admin/users/access', 'view'), adminController.getUserTimekeeperObjects);
router.put('/users/:id/timekeeper-objects', requirePageAccess('/admin/users/access', 'edit'), adminController.updateUserTimekeeperObjects);
router.get('/users/:id/timekeeper-folders', requirePageAccess('/admin/users/access', 'view'), adminController.getUserTimekeeperFolders);
router.put('/users/:id/timekeeper-folders', requirePageAccess('/admin/users/access', 'edit'), adminController.updateUserTimekeeperFolders);

// Привязка администраторов к «компаниям» (корневым узлам Sigur). Только системный админ.
router.get('/companies', requirePageAccess('/admin/users/access', 'view'), adminController.listCompanies);
router.get('/users/:id/companies', requirePageAccess('/admin/users/access', 'view'), adminController.getUserCompanies);
router.put('/users/:id/companies', requirePageAccess('/admin/users/access', 'edit'), adminController.replaceUserCompanies);

// 2FA управление
router.post('/users/:id/generate-2fa', requirePageAccess('/admin/users/access', 'edit'), adminController.generate2FA);
router.post('/users/:id/disable-2fa', requirePageAccess('/admin/users/access', 'edit'), adminController.disable2FA);

// Поиск сотрудников (для привязки при одобрении)
router.get('/employees/search', requirePageAccess('/admin/users', 'view'), adminController.searchUnlinkedEmployees);

// Аудит логи
router.get('/audit-logs', requirePageAccess('/admin/audit', 'view'), adminController.getAuditLogs);

// Мини-монитор ресурсов сервера (CPU/RAM/uptime + статус фоновых сервисов)
router.get('/system-resources', requirePageAccess('/admin/settings', 'view'), adminSystemResourcesController.getSystemResources);

export default router;
