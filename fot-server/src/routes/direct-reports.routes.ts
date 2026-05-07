import { Router } from 'express';
import { directReportsController } from '../controllers/direct-reports.controller.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';

const router = Router();

router.use(authenticate);

// Любой успешный write на /api/direct-reports/* меняет состав псевдо-ячейки
// руководителя → сбрасываем timesheet-LRU, иначе overview/getAll до 5 минут
// будут отдавать старый состав сотрудников.
router.use((req, res, next) => {
  res.on('finish', () => {
    const isWrite = req.method === 'POST' || req.method === 'PUT'
      || req.method === 'PATCH' || req.method === 'DELETE';
    if (isWrite && res.statusCode >= 200 && res.statusCode < 300) {
      invalidateCaches(
        'timesheet',
        'timesheet:today',
        'timesheet:overview',
        'timesheet:overview:today',
        'timesheet:search',
      );
    }
  });
  next();
});

router.get('/', directReportsController.list);
router.post('/', requireAdmin, directReportsController.assign);
router.delete('/:id', requireAdmin, directReportsController.unassign);

export default router;
