import { Router } from 'express';
import multer from 'multer';
import { documentsController } from '../controllers/documents.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(authenticate);

// POST /api/documents/upload — multipart-загрузка файла через бэкенд в S3
router.post(
  '/upload',
  requireAnyPageAccess(['/employee/documents', '/employee/requests'], 'edit'),
  upload.single('file'),
  documentsController.uploadFile
);

// GET /api/documents/my — мои документы
router.get(
  '/my',
  requirePageAccess('/employee/documents', 'view'),
  documentsController.getMy
);

// GET /api/documents/employee/:empId — документы сотрудника
router.get(
  '/employee/:empId',
  requirePageAccess('/staff-control', 'view'),
  documentsController.getByEmployee
);

// GET /api/documents/leave-request/:leaveRequestId — документы, прикреплённые к заявке
router.get(
  '/leave-request/:leaveRequestId',
  requireAnyPageAccess(['/employee', '/employee/requests', '/leave-requests'], 'view'),
  documentsController.getByLeaveRequest
);

// GET /api/documents/:id/download — скачать
router.get(
  '/:id/download',
  requireAnyPageAccess(['/employee/documents', '/employee/requests', '/staff-control', '/leave-requests'], 'view'),
  documentsController.getDownloadUrl
);

// DELETE /api/documents/:id — удалить
router.delete(
  '/:id',
  requireAnyPageAccess(['/employee/documents', '/employee/requests', '/staff-control'], 'edit'),
  documentsController.remove
);

export default router;
