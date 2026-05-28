import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { employeesController } from '../controllers/employees.controller.js';
import { employeeObjectAttributionController } from '../controllers/employee-object-attribution.controller.js';
import { employeeEnrichController } from '../controllers/employee-enrich.controller.js';
import { employeeSalaryEnrichController } from '../controllers/employee-enrich-salary.controller.js';
import { employeeSalaryHistoryController } from '../controllers/employee-enrich-salary-history.controller.js';
import { employeeEnrichContactsController } from '../controllers/employee-enrich-contacts.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess, requireCritical2FA, requireAdmin } from '../middleware/auth.js';
import { importLimiter } from '../middleware/rateLimit.js';
import { isExcelBuffer, sanitizeFileName } from '../utils/file-validation.utils.js';

const router = Router();

// Настройка multer для загрузки файлов в память
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
  fileFilter: (_req, file, cb) => {
    // MIME-фильтр: первичная проверка. Браузеры/curl могут отдать
    // application/octet-stream для xlsx, поэтому проверяем и расширение.
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
      'application/vnd.ms-excel', // xls
      'application/octet-stream',
      '',
    ];
    const hasExcelExt = /\.(xlsx|xls)$/i.test(file.originalname || '');
    if (allowedMimes.includes(file.mimetype) || hasExcelExt) {
      cb(null, true);
    } else {
      cb(new Error('Недопустимый формат файла. Разрешены только .xlsx и .xls'));
    }
  },
});

// Magic-bytes проверка после multer и sanitize originalname.
// MIME контролирует клиент, расширение можно подделать — magic-bytes отсекают
// переименованные файлы до тяжёлого парсинга.
function validateExcelUpload(req: Request, res: Response, next: NextFunction): void {
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
}

// Все роуты требуют аутентификации
router.use(authenticate);

// GET /api/employees - получение списка (worker+)
router.get(
  '/',
  requirePageAccess('/staff-control', 'view'),
  employeesController.getAll
);

// POST /api/employees/enrich - обогащение данных из Excel (header+, требуется 2FA)
router.post(
  '/enrich',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  validateExcelUpload,
  employeeEnrichController.enrich
);

// POST /api/employees/enrich-salary - импорт окладов и ставок из Excel (header+, требуется 2FA)
router.post(
  '/enrich-salary',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  validateExcelUpload,
  employeeSalaryEnrichController.enrichSalary
);

// POST /api/employees/enrich-salary-history - импорт истории окладов из Excel (header+, требуется 2FA)
router.post(
  '/enrich-salary-history',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  validateExcelUpload,
  employeeSalaryHistoryController.enrichSalaryHistory
);

// POST /api/employees/enrich-contacts - импорт email из Excel (header+, требуется 2FA)
router.post(
  '/enrich-contacts',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  validateExcelUpload,
  employeeEnrichContactsController.enrichContacts
);

// DELETE /api/employees/all - удаление ВСЕХ (admin, только для разработки)
router.delete(
  '/all',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  employeesController.deleteAll
);

// GET /api/employees/counts - счётчики по отделам + статусам (worker+, кэш 60с)
router.get(
  '/counts',
  requirePageAccess('/staff-control', 'view'),
  employeesController.getCounts
);

// GET /api/employees/:id/history - история событий сотрудника (worker+, для полной карточки требуется /employees)
router.get(
  '/:id/history',
  requireAnyPageAccess(['/employee', '/employees'], 'view'),
  employeesController.getHistory
);

// PUT /api/employees/:id/history/:eventId - редактирование записи истории (только admin, 2FA)
router.put(
  '/:id/history/:eventId',
  requireAdmin,
  requireCritical2FA,
  employeesController.updateHistoryEvent
);

// DELETE /api/employees/:id/history/:eventId - удаление записи истории (только admin, 2FA)
router.delete(
  '/:id/history/:eventId',
  requireAdmin,
  requireCritical2FA,
  employeesController.deleteHistoryEvent
);

// Привязка удалёнщика к объекту (employee_object_attribution) — управление из /staff-control.
// Статический путь объявлен до '/:id', чтобы не быть перехваченным параметром.
router.get(
  '/object-attribution/objects',
  requirePageAccess('/staff-control', 'view'),
  employeeObjectAttributionController.listObjects
);
router.get(
  '/:id/object-attribution',
  requirePageAccess('/staff-control', 'view'),
  employeeObjectAttributionController.get
);
router.put(
  '/:id/object-attribution',
  // Та же зона прав, что и редактирование графика (кнопка живёт в ячейке графика,
  // показывается только для remote). На фронте — canEditSch.
  requirePageAccess('/staff-control/schedule', 'edit'),
  employeeObjectAttributionController.set
);

// GET /api/employees/:id - получение одного (worker через /employee, остальные — через /employees)
router.get(
  '/:id',
  requireAnyPageAccess(['/employee', '/employees'], 'view'),
  employeesController.getById
);

// POST /api/employees - создание (header+, требуется 2FA)
router.post(
  '/',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  employeesController.create
);

// POST /api/employees/batch-move - массовый перевод в отдел (header+, требуется 2FA)
router.post(
  '/batch-move',
  requirePageAccess('/staff-control/department', 'edit'),
  requireCritical2FA,
  employeesController.batchMoveEmployees
);

// PUT /api/employees/:id - обновление (header+, требуется 2FA)
router.put(
  '/:id',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  employeesController.update
);

// POST /api/employees/:id/fire - уволить (header+)
router.post(
  '/:id/fire',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  employeesController.fire
);

// POST /api/employees/:id/rehire - восстановить на работу (header+)
router.post(
  '/:id/rehire',
  requirePageAccess('/staff-control', 'edit'),
  employeesController.rehire
);

// POST /api/employees/:id/cancel-dismissal - отменить запланированное увольнение (header+)
router.post(
  '/:id/cancel-dismissal',
  requirePageAccess('/staff-control', 'edit'),
  employeesController.cancelDismissal
);

// POST /api/employees/:id/move-department - переместить в отдел (header+)
router.post(
  '/:id/move-department',
  requirePageAccess('/staff-control/department', 'edit'),
  requireCritical2FA,
  employeesController.moveDepartment
);

// POST /api/employees/:id/change-salary - изменить оклад (admin+, требуется 2FA)
router.post(
  '/:id/change-salary',
  requirePageAccess('/staff-control', 'edit'),
  requireCritical2FA,
  employeesController.changeSalary
);

// POST /api/employees/:id/change-position - сменить должность (admin+, требуется 2FA)
router.post(
  '/:id/change-position',
  requirePageAccess('/staff-control/position', 'edit'),
  requireCritical2FA,
  employeesController.changePosition
);

export default router;
