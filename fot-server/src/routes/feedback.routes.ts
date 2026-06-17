import { Router } from 'express';
import { feedbackController } from '../controllers/feedback.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

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

// Скрытые из сводки задач отделы СУ-10 (общая настройка). noStore — иначе
// браузерный max-age=30 отдаёт старое значение 30 с после сохранения.
router.get(
  '/hidden-departments',
  requirePageAccess('/feedback-review', 'view'),
  noStore,
  feedbackController.getHiddenDepartments,
);

router.put(
  '/hidden-departments',
  requirePageAccess('/feedback-review', 'edit'),
  feedbackController.saveHiddenDepartments,
);

router.delete(
  '/:id',
  requirePageAccess('/feedback-review', 'edit'),
  feedbackController.remove,
);

export default router;

