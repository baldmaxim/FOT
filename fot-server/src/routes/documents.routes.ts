import { Router } from 'express';
import { documentsController } from '../controllers/documents.controller.js';
import { authenticate, requirePosition, requireOrganization, injectOrganizationFromQuery } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);
router.use(injectOrganizationFromQuery);
router.use(requireOrganization);

// POST /api/documents/upload-url — получить presigned URL
router.post(
  '/upload-url',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  documentsController.getUploadUrl
);

// POST /api/documents/confirm — подтвердить загрузку
router.post(
  '/confirm',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  documentsController.confirmUpload
);

// GET /api/documents/my — мои документы
router.get(
  '/my',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  documentsController.getMy
);

// GET /api/documents/employee/:empId — документы сотрудника
router.get(
  '/employee/:empId',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  documentsController.getByEmployee
);

// GET /api/documents/:id/download — скачать
router.get(
  '/:id/download',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  documentsController.getDownloadUrl
);

// DELETE /api/documents/:id — удалить
router.delete(
  '/:id',
  requirePosition('hr', 'admin', 'super_admin'),
  documentsController.remove
);

export default router;
