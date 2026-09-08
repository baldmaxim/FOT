import { Router } from 'express';
import { directReportsController } from '../controllers/direct-reports.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
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

// Назначение подчинённых — кадровая операция, а не админская: отдельный ключ
// /staff-control/direct-reports (миграция 270). Не '/staff-control' edit, чтобы
// право не разошлось по всем ролям с доступом к кадрам.
// GET остаётся под authenticate: обычный пользователь читает своих подчинённых
// (self-service), а чужого руководителя контроллер отдаёт только по этому ключу.
router.get('/', directReportsController.list);
router.post('/', requirePageAccess('/staff-control/direct-reports', 'edit'), directReportsController.assign);
router.delete('/:id', requirePageAccess('/staff-control/direct-reports', 'edit'), directReportsController.unassign);

export default router;
