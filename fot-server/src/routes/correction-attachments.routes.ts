import { Router } from 'express';
import multer from 'multer';
import { requireAnyPageAccess } from '../middleware/auth.js';
import { correctionAttachmentsController } from '../controllers/correction-attachments.controller.js';

// Подключается как sub-router в timesheet.routes.ts — authenticate уже выполнен parent-ом.
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// POST /api/timesheet/corrections/attachments/bulk (multipart `file` + `adjustment_ids`)
// Один файл → один документ → ссылки на все переданные корректировки (дни) одного сотрудника.
// Регистрируется ДО параметрических роутов `/:id/...`.
router.post(
  '/attachments/bulk',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/employee/requests'], 'edit'),
  upload.single('file'),
  correctionAttachmentsController.uploadBulk,
);

// GET /api/timesheet/corrections/:id/attachments
router.get(
  '/:id/attachments',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/employee/requests'], 'view'),
  correctionAttachmentsController.list,
);

// POST /api/timesheet/corrections/:id/attachments (multipart `file`)
router.post(
  '/:id/attachments',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/employee/requests'], 'edit'),
  upload.single('file'),
  correctionAttachmentsController.upload,
);

// DELETE /api/timesheet/corrections/:id/attachments/:attId
router.delete(
  '/:id/attachments/:attId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/employee/requests'], 'edit'),
  correctionAttachmentsController.remove,
);

export default router;
