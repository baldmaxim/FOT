/**
 * busboy (используется multer) декодирует Content-Disposition filename как
 * latin1 по умолчанию (RFC 7578). Современные браузеры шлют UTF-8 байты —
 * и они читаются как latin1, превращая кириллицу в иероглифы вида
 * «Ð_Ð_Ñ_Ð¾Ð²Ð_Ð_µ». Конвертируем байты обратно к UTF-8.
 *
 * Применять ВО ВСЕХ местах, где читается `req.file.originalname`, перед
 * вызовом sanitizeFileName / сохранением в БД.
 */
export function decodeMulterFilename(originalname: string): string {
  return Buffer.from(originalname, 'latin1').toString('utf8');
}
