import { Router, Response } from 'express';
import { authenticate, requireAnyPageAccess } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

const SIGUR_READER_DRIVER_URL = '/downloads/sigur-reader-eh-setup-1.0.0.exe';
const SIGUR_READER_DRIVER_FILE_NAME = 'Sigur Reader EH Setup 1.0.0.exe';

router.use(authenticate);

router.get(
  '/sigur-reader-driver',
  requireAnyPageAccess(['/skud-card-reader', '/skud-settings'], 'view'),
  (_req: AuthenticatedRequest, res: Response): void => {
    res.json({
      success: true,
      data: { download_url: SIGUR_READER_DRIVER_URL, file_name: SIGUR_READER_DRIVER_FILE_NAME },
    });
  },
);

export default router;
