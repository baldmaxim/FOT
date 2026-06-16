import { Router } from 'express';
import { feedbackController } from '../controllers/feedback.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// Сотрудник: отправка предложения/жалобы.
router.post(
  '/',
  requirePageAccess('/employee/feedback', 'edit'),
  feedbackController.submit,
);

// Администратор: списки + статистика.
router.get(
  '/messages',
  requirePageAccess('/feedback-review', 'view'),
  feedbackController.listMessages,
);

router.get(
  '/tasks',
  requirePageAccess('/feedback-review', 'view'),
  feedbackController.listTasks,
);

router.get(
  '/tasks/department/:id',
  requirePageAccess('/feedback-review', 'view'),
  feedbackController.getDepartmentTasks,
);

router.delete(
  '/:id',
  requirePageAccess('/feedback-review', 'edit'),
  feedbackController.remove,
);

export default router;

