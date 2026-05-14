import { Router, Response } from 'express';
import multer from 'multer';
import { authenticate, requireAnyPageAccess } from '../middleware/auth.js';
import { r2Service } from '../services/r2.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

const SIGUR_READER_DRIVER_KEY = 'public/downloads/sigur-reader-eh-setup-1.0.0.exe';
const SIGUR_READER_DRIVER_FILE_NAME = 'Sigur Reader EH Setup 1.0.0.exe';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
});

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

// Временный загрузчик: админ через UI заливает локальный .exe в R2 под фиксированный ключ.
// Чтобы не возиться с SSH/локальными R2-кредами.
router.post(
  '/sigur-reader-driver',
  requireAnyPageAccess(['/skud-card-reader', '/skud-settings'], 'edit'),
  upload.single('file'),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ success: false, error: 'Файл не получен (поле "file")' });
        return;
      }
      await r2Service.uploadObject(
        SIGUR_READER_DRIVER_KEY,
        file.buffer,
        file.mimetype || 'application/octet-stream',
      );
      res.json({
        success: true,
        data: { size: file.size, key: SIGUR_READER_DRIVER_KEY },
      });
    } catch (err) {
      console.error('downloads.sigur-reader-driver upload error:', err);
      res.status(500).json({ success: false, error: 'Не удалось загрузить драйвер в R2' });
    }
  },
);

export default router;
