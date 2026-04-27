import { Router } from 'express';
import { documentsController } from '../controllers/documents.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// POST /api/documents/upload-url — получить presigned URL
router.post(
  '/upload-url',
  requireAnyPageAccess(['/employee/documents', '/employee/requests'], 'edit'),
  documentsController.getUploadUrl
);

// POST /api/documents/confirm — подтвердить загрузку
router.post(
  '/confirm',
  requireAnyPageAccess(['/employee/documents', '/employee/requests'], 'edit'),
  documentsController.confirmUpload
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
  requireAnyPageAccess(['/employees', '/staff-control'], 'view'),
  documentsController.getByEmployee
);

// GET /api/documents/leave-request/:leaveRequestId — документы, прикреплённые к заявке
router.get(
  '/leave-request/:leaveRequestId',
  requireAnyPageAccess(['/employee', '/employee/requests', '/leave-requests'], 'view'),
  documentsController.getByLeaveRequest
);

// GET /api/documents/attendance-adjustment/:adjustmentId — документы корректировки табеля
router.get(
  '/attendance-adjustment/:adjustmentId',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/employee', '/employee/requests'], 'view'),
  documentsController.getByAttendanceAdjustment
);

// GET /api/documents/:id/download — скачать
router.get(
  '/:id/download',
  requireAnyPageAccess(['/employee/documents', '/employees', '/staff-control'], 'view'),
  documentsController.getDownloadUrl
);

// DELETE /api/documents/:id — удалить
router.delete(
  '/:id',
  requireAnyPageAccess(['/employee/documents', '/employees', '/staff-control'], 'edit'),
  documentsController.remove
);

export default router;
