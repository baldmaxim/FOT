import { Router, type NextFunction, type Response } from 'express';
import { requirePageAccess } from '../middleware/auth.js';
import { acceptMemoFile } from '../middleware/blacklistMemoUpload.js';
import { canManageAsHrAdmin } from '../services/access-control.service.js';
import { timesheetDayFilesController } from '../controllers/timesheet-day-files.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

// Подключается как sub-router в timesheet.routes.ts — authenticate уже выполнен parent-ом.
const router = Router();

// «Файлы дня» видит и ведёт только кадровый админ (и системный админ). Гард стоит ДО приёма
// файла: без права 25 МБ не читаются в память.
const requireHrAdmin = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (await canManageAsHrAdmin(req, '/timesheet-hr')) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: 'Файлы дня доступны только кадровому админу' });
  } catch (err) {
    next(err);
  }
};

// GET /api/timesheet/day-files?employee_id=&work_date=
router.get('/', requirePageAccess('/timesheet-hr', 'view'), requireHrAdmin, timesheetDayFilesController.list);

// POST /api/timesheet/day-files (multipart `file` + `employee_id` + `work_date`)
router.post('/', requirePageAccess('/timesheet-hr', 'edit'), requireHrAdmin, acceptMemoFile, timesheetDayFilesController.upload);

// DELETE /api/timesheet/day-files/:documentId
router.delete('/:documentId', requirePageAccess('/timesheet-hr', 'edit'), requireHrAdmin, timesheetDayFilesController.remove);

export default router;
