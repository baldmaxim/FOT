import type { RequestHandler } from 'express';
import multer from 'multer';

/** Максимальный размер служебной записки чёрного списка. */
export const MEMO_MAX_BYTES = 25 * 1024 * 1024;

const memoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEMO_MAX_BYTES, files: 1 },
});

/**
 * Приём файла служебной записки (поле `file`). Ошибки multer превращаются в
 * понятные ответы: превышение размера — 413, прочие ошибки формы — 400, а не 500.
 * Ставить ПОСЛЕ проверок доступа и 2FA — без них файл не должен читаться в память.
 */
export const acceptMemoFile: RequestHandler = (req, res, next) => {
  memoUpload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ success: false, error: 'Файл больше 25 МБ' });
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
    next();
  });
};
