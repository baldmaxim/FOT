import { Router } from 'express';
import { dailyTasksController } from '../controllers/daily-tasks.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get(
  '/my',
  requirePageAccess('/employee/tasks', 'view'),
  dailyTasksController.getMy,
);

router.get(
  '/today',
  requirePageAccess('/employee/tasks', 'view'),
  dailyTasksController.getToday,
);

router.post(
  '/',
  requirePageAccess('/employee/tasks', 'edit'),
  dailyTasksController.upsert,
);

export default router;
