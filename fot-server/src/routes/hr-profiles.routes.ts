/**
 * /api/hr-profiles — кадровый модуль («Реквизиты», сканы, мастер, ЗУП).
 * Чтение — view на /staff-control/hr-profiles, запись — edit + require2FA
 * (2FA не обязательна: кто её не включал — работает; у кого включена — сессия
 * должна быть подтверждена). Staging — только is_admin.
 */
import { Router } from 'express';
import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { authenticate, require2FA, requireAdmin, requirePageAccess } from '../middleware/auth.js';

// Персональные данные — никакого кэширования ни в браузере, ни в прокси.
const noStore = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};
import { hrProfilesController } from '../controllers/hr-profiles.controller.js';
import { hrDocumentsController } from '../controllers/hr-documents.controller.js';
import { hrDraftsController } from '../controllers/hr-drafts.controller.js';
import { hrStagingController } from '../controllers/hr-staging.controller.js';
import { HR_FILE_MAX_BYTES } from '../services/hr-documents.service.js';
import { requireHrEnabled } from '../services/hr-feature-flag.service.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: HR_FILE_MAX_BYTES, files: 1 } });

const view = requirePageAccess('/staff-control/hr-profiles', 'view');
const edit = [requirePageAccess('/staff-control/hr-profiles', 'edit'), require2FA] as const;

router.use(authenticate);
router.use(noStore);
// Каталог доступен всегда: по полю enabled фронт решает, показывать ли модуль.
router.get('/catalog', view, hrProfilesController.catalog);

// Флаг раскатки: пока выключен — остальной модуль отвечает 503 и в UI не появляется.
router.use(requireHrEnabled);

router.get('/departments', view, hrProfilesController.departments);
router.get('/', view, hrProfilesController.list);
router.get('/employees/search', view, hrProfilesController.searchEmployees);
router.get('/duplicates', ...edit, hrProfilesController.duplicates);

// ЗУП
router.get('/export/zup', ...edit, hrProfilesController.zupExport);
router.post('/zup/bulk', ...edit, hrProfilesController.zupBulk);

// Черновики мастера (до создания сотрудника)
router.post('/drafts', ...edit, hrDraftsController.create);
router.get('/drafts', ...edit, hrDraftsController.listMine);
router.get('/drafts/:draftId', ...edit, hrDraftsController.get);
router.patch('/drafts/:draftId', ...edit, hrDraftsController.patch);
router.post('/drafts/:draftId/documents', ...edit, upload.single('file'), hrDocumentsController.uploadForDraft);
router.get('/drafts/:draftId/documents', ...edit, hrDocumentsController.listForDraft);
router.post('/drafts/:draftId/attach', ...edit, hrDraftsController.attach);
router.post('/drafts/:draftId/mark-created', ...edit, hrDraftsController.markCreated);

// Документы (по id) — только через HR API
router.get('/documents/:id/content', ...edit, hrDocumentsController.content);
router.delete('/documents/:id', ...edit, hrDocumentsController.remove);
router.post('/documents/:id/recognize', ...edit, hrDocumentsController.recognize);

// Конфликты OCR
router.post('/ocr-conflicts/:id/apply', ...edit, hrProfilesController.applyConflict);
router.post('/ocr-conflicts/:id/dismiss', ...edit, hrProfilesController.dismissConflict);

// Staging (несопоставленные из PassDesk) — только админ
router.get('/staging', requireAdmin, hrStagingController.list);
router.get('/staging/:id', requireAdmin, hrStagingController.get);
router.post('/staging/:id/link', requireAdmin, require2FA, hrStagingController.link);

// Профиль сотрудника
router.get('/:employeeId', view, hrProfilesController.getOne);
router.get('/:employeeId/sensitive', ...edit, hrProfilesController.sensitive);
router.post('/:employeeId', ...edit, hrProfilesController.create);
router.put('/:employeeId', ...edit, hrProfilesController.update);
router.get('/:employeeId/history', view, hrProfilesController.history);
router.get('/:employeeId/documents', view, hrDocumentsController.listForEmployee);
router.post('/:employeeId/documents', ...edit, upload.single('file'), hrDocumentsController.uploadForEmployee);
router.get('/:employeeId/ocr-conflicts', view, hrProfilesController.conflicts);
router.patch('/:employeeId/zup', ...edit, hrProfilesController.zupToggle);

export default router;
