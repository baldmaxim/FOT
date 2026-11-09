import type { RequestHandler } from 'express';
import multer from 'multer';

/** Файл разовой доплаты — не больше 25 МБ (как служебки). */
export const SUPPLEMENT_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Файлов у одной доплаты — не больше 10 (и в одном запросе тоже). */
export const SUPPLEMENT_FILES_MAX = 10;
/** Файлов за одно сохранение — не больше 50 МБ: они читаются в память процесса. */
export const SUPPLEMENT_FILES_TOTAL_MAX_BYTES = 50 * 1024 * 1024;
/** Запас на служебную часть формы (границы, заголовки частей, поле data) — сверх суммы файлов. */
const FORM_OVERHEAD_BYTES = 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SUPPLEMENT_FILE_MAX_BYTES, files: SUPPLEMENT_FILES_MAX, fields: 4, fieldSize: 64 * 1024 },
});

const FORM_ERROR = { success: false, error: 'Некорректные данные формы' };

/**
 * Файлы разовой доплаты: multipart — поле `data` (JSON) и до 10 полей `files`; JSON-запрос (прежний клиент,
 * правка без новых файлов) проходит как есть. Ставить ПОСЛЕ гарда раздела: без него файлы не читаются в память.
 * Размер всего запроса проверяется до чтения тела — по Content-Length (браузер его присылает у FormData).
 */
export const acceptSupplementFiles: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    next();
    return;
  }
  const header = req.headers['content-length'];
  if (header === undefined) {
    res.status(411).json({ success: false, error: 'Не указан размер запроса' });
    return;
  }
  const length = Number(header);
  if (!Number.isFinite(length) || length < 0) {
    res.status(400).json(FORM_ERROR);
    return;
  }
  if (length > SUPPLEMENT_FILES_TOTAL_MAX_BYTES + FORM_OVERHEAD_BYTES) {
    res.status(413).json({ success: false, error: 'Не больше 50 МБ за одно сохранение' });
    return;
  }
  upload.array('files', SUPPLEMENT_FILES_MAX)(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ success: false, error: 'Файл больше 25 МБ' });
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT' || (err.code === 'LIMIT_UNEXPECTED_FILE' && err.field === 'files')) {
        res.status(400).json({ success: false, error: 'Не больше 10 файлов', code: 'SUPPLEMENT_FILES_LIMIT' });
        return;
      }
      res.status(400).json(FORM_ERROR);
      return;
    }
    // memoryStorage ничего не пишет: прочие ошибки — разбор тела (оборванная форма).
    if (err) {
      res.status(400).json(FORM_ERROR);
      return;
    }
    next();
  });
};
