import type { NextFunction, Response } from 'express';
import multer from 'multer';

import type { AuthenticatedRequest } from '../types/index.js';
import { canImportPayouts1c } from '../services/payroll/payroll-1c-payouts.access.js';

/** Максимальный размер файла ведомости выплаты из 1С. */
export const PAYOUT_1C_MAX_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PAYOUT_1C_MAX_BYTES, files: 1, fields: 10, fieldSize: 1024 * 1024 },
});

/**
 * Право на загрузку ведомости (canImportPayouts1c) — ДО приёма файла: без права файл не читается в память.
 * Ставить после requirePageAccess-алиаса маршрута.
 */
export const requirePayouts1cImport = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!(await canImportPayouts1c(req))) {
      res.status(403).json({ success: false, error: 'Загружать ведомости из 1С может только тот, кому доступна вся «Зарплата»' });
      return;
    }
    next();
  } catch (err) {
    console.error('requirePayouts1cImport error:', err);
    res.status(500).json({ success: false, error: 'Authorization check failed' });
  }
};

/**
 * Приём файла ведомости (поле `file`, .xml). Ошибки multer — понятными ответами: размер — 413, прочие — 400.
 * Содержимое файла в логи не пишется (в ЗУП2-выгрузке есть паспортные данные).
 */
export const acceptPayout1cFile = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ success: false, error: 'Файл больше 5 МБ' });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(400).json({ success: false, error: 'Приложите один файл в поле file' });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'Приложите файл ведомости (.xml)' });
      return;
    }
    if (!/\.xml$/i.test(file.originalname)) {
      res.status(400).json({ success: false, error: 'Нужен файл .xml — выгрузка ведомости выплаты из 1С' });
      return;
    }
    next();
  });
};
