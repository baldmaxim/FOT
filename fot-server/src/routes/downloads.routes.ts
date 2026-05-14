import { Router, Response } from 'express';
import { authenticate, requireAnyPageAccess } from '../middleware/auth.js';
import { r2Service } from '../services/r2.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

const SIGUR_READER_DRIVER_KEY = 'public/downloads/sigur-reader-eh-setup-1.0.0.exe';
const SIGUR_READER_DRIVER_FILE_NAME = 'Sigur Reader EH Setup 1.0.0.exe';

router.use(authenticate);

router.get(
  '/sigur-reader-driver',
  requireAnyPageAccess(['/skud-card-reader', '/skud-settings'], 'view'),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const downloadUrl = await r2Service.generateDownloadUrl(SIGUR_READER_DRIVER_KEY);
      res.json({
        success: true,
        data: { download_url: downloadUrl, file_name: SIGUR_READER_DRIVER_FILE_NAME },
      });
    } catch (err) {
      console.error('downloads.sigur-reader-driver error:', err);
      res.status(500).json({ success: false, error: 'Не удалось получить ссылку на драйвер' });
    }
  },
);

// Временный аплоадер: возвращает presigned PUT-URL, фронт льёт файл прямо в R2.
// Так минуем nginx client_max_body_size и express body-limits — для 81 МБ .exe.
router.get(
  '/sigur-reader-driver/upload-url',
  requireAnyPageAccess(['/skud-card-reader', '/skud-settings'], 'edit'),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { url, headers } = await r2Service.generateUploadUrl(
        SIGUR_READER_DRIVER_KEY,
        'application/octet-stream',
      );
      res.json({ success: true, data: { url, headers, key: SIGUR_READER_DRIVER_KEY } });
    } catch (err) {
      console.error('downloads.sigur-reader-driver upload-url error:', err);
      res.status(500).json({ success: false, error: 'Не удалось получить ссылку на загрузку' });
    }
  },
);

export default router;
