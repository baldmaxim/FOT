import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { adminController } from '../controllers/admin.controller.js';
import { adminSystemResourcesController } from '../controllers/admin-system-resources.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';
import { isExcelBuffer, sanitizeFileName } from '../utils/file-validation.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

const ACCEPTED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  // Windows/Chrome нередко отдают .xlsx так — считаем валидным,
  // если расширение совпадает.
  'application/octet-stream',
  '',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const hasExcelExtension = /\.(xlsx|xls)$/i.test(file.originalname || '');
    if (ACCEPTED_MIMES.has(file.mimetype) || hasExcelExtension) {
      cb(null, true);
      return;
    }
    cb(new Error(
      `Недопустимый формат файла (${file.mimetype || 'unknown'}). Разрешены .xlsx и .xls`,
    ));
  },
});

/**
 * Оборачивает multer так, чтобы его ошибки (лимит размера, отклонённый
 * mime, невалидный form-data) превращались в 400 JSON, а не голый 500.
 * После успешной загрузки — magic-bytes проверка + sanitize originalname.
 */
function uploadSingleFile(field: string) {
  const middleware = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, err => {
      if (err) {
        const message = err instanceof Error ? err.message : 'Ошибка загрузки файла';
        res.status(400).json({ success: false, error: message });
        return;
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (file) {
        if (!isExcelBuffer(file.buffer)) {
          res.status(400).json({
            success: false,
            error: 'Файл не является корректным Excel-документом (.xlsx/.xls).',
          });
          return;
        }
        file.originalname = sanitizeFileName(file.originalname);
      }
      next();
    });
  };
}

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
      invalidateCaches('admin:users:list', 'admin:users:pending');
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

// Пользователи — доступно admin
router.get('/users', requirePageAccess('/admin/users', 'view'), usersListCache, adminController.getAllUsers);
router.get('/users/pending', requirePageAccess('/admin/users', 'view'), pendingUsersCache, adminController.getPendingUsers);
router.get('/employees/department-access', requirePageAccess('/admin/users', 'view'), adminController.getEmployeeDepartmentAssignments);
router.post(
  '/users/department-access-import/preview',
  requirePageAccess('/admin/users', 'view'),
  uploadSingleFile('file'),
  adminController.previewDepartmentAccessImport,
);
router.post(
  '/users/department-access-import/apply',
  requirePageAccess('/admin/users', 'edit'),
  adminController.applyDepartmentAccessImport,
);
router.post(
  '/users/department-access-import/apply-worker-transfers',
  requirePageAccess('/admin/users', 'edit'),
  adminController.applyBrigadeWorkerTransfers,
);
router.delete(
  '/users/department-access-assignments',
  requirePageAccess('/admin/users', 'edit'),
  adminController.clearDepartmentAssignments,
);
router.post('/users/:id/approve', requirePageAccess('/admin/users', 'edit'), adminController.approveUser);
router.post('/users/:id/reject', requirePageAccess('/admin/users', 'edit'), adminController.rejectUser);
router.delete('/users/:id', requirePageAccess('/admin/users', 'edit'), adminController.deleteUser);
router.post('/users/:id/confirm-email', requirePageAccess('/admin/users', 'edit'), adminController.confirmUserEmail);
router.post('/users/:id/reset-link', requirePageAccess('/admin/users', 'edit'), adminController.generatePasswordResetLink);
router.patch('/users/:id/position', requirePageAccess('/admin/users', 'edit'), adminController.updateUserPosition);
router.patch('/users/:id/name', requirePageAccess('/admin/users', 'edit'), adminController.updateUserName);
router.patch('/users/:id/chat-inbound-mode', requirePageAccess('/admin/users', 'edit'), adminController.updateUserChatInboundMode);
router.patch('/users/:id/employee', requirePageAccess('/admin/users', 'edit'), adminController.updateUserEmployee);
router.put('/users/:id/department-access', requirePageAccess('/admin/users', 'edit'), adminController.updateUserDepartmentAccess);
router.put('/employees/:id/department-access', requirePageAccess('/admin/users', 'edit'), adminController.updateEmployeeDepartmentAccess);

// Приписка сотрудника к объектам строительства (миграция 092).
router.get('/skud-objects', requirePageAccess('/admin/users', 'view'), adminController.listSkudObjectsForAssignment);
router.get('/employees/:id/skud-objects', requirePageAccess('/admin/users', 'view'), adminController.getEmployeeSkudObjects);
router.put('/employees/:id/skud-objects', requirePageAccess('/admin/users', 'edit'), adminController.updateEmployeeSkudObjectAccess);

// Начальник участка: флаг + прямые назначения сотрудников (миграция 090).
router.patch('/users/:id/site-supervisor', requirePageAccess('/admin/users', 'edit'), adminController.setSiteSupervisor);
router.put('/users/:id/employee-access', requirePageAccess('/admin/users', 'edit'), adminController.updateUserEmployeeAccess);

// Привязка администраторов к «компаниям» (корневым узлам Sigur). Только системный админ.
router.get('/companies', requirePageAccess('/admin/users', 'view'), adminController.listCompanies);
router.get('/users/:id/companies', requirePageAccess('/admin/users', 'view'), adminController.getUserCompanies);
router.put('/users/:id/companies', requirePageAccess('/admin/users', 'edit'), adminController.replaceUserCompanies);

// 2FA управление
router.post('/users/:id/generate-2fa', requirePageAccess('/admin/users', 'edit'), adminController.generate2FA);
router.post('/users/:id/disable-2fa', requirePageAccess('/admin/users', 'edit'), adminController.disable2FA);

// Поиск сотрудников (для привязки при одобрении)
router.get('/employees/search', requirePageAccess('/admin/users', 'view'), adminController.searchUnlinkedEmployees);

// Аудит логи
router.get('/audit-logs', requirePageAccess('/admin/audit', 'view'), adminController.getAuditLogs);

// Мини-монитор ресурсов сервера (CPU/RAM/uptime + статус фоновых сервисов)
router.get('/system-resources', requirePageAccess('/admin/settings', 'view'), adminSystemResourcesController.getSystemResources);

export default router;
