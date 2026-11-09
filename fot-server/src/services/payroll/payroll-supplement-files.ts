/**
 * Файлы разовой доплаты (миграция 354): проверка присланного, загрузка в R2 и удаление объектов.
 *
 * Объекты R2 вне транзакции БД: загрузка — до неё (упала загрузка или транзакция — загруженное удаляется),
 * удаление снятых — после коммита, best-effort. Сбой процесса между R2 и коммитом оставляет объект без
 * строки — его никто не видит.
 */
import * as Sentry from '@sentry/node';

import { r2Service } from '../r2.service.js';
import { detectMemoFileType, sanitizeFileName } from '../../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../../utils/multer-filename.utils.js';
import type { INewOneTimeSupplementFile } from './payroll-supplements.service.js';

/** Длина имени файла в БД (CHECK миграции 354). */
const FILE_NAME_MAX = 200;
const TYPES_HINT = 'допустимы PDF, JPG, PNG, WEBP, DOC, DOCX';

export interface IPreparedSupplementFile {
  buffer: Buffer;
  fileName: string;
  /** С точкой, в нижнем регистре: «.pdf». */
  ext: string;
  fileSize: number;
  mimeType: string;
}

/**
 * Имя для БД и скачивания: основа очищается (sanitizeFileName) и укорачивается так, чтобы с расширением
 * влезть в 200 символов, — расширение не теряется, апостроф защиты CSV тоже в пределах.
 */
export const supplementFileName = (decodedName: string, ext: string): string => {
  const base = decodedName.slice(0, decodedName.length - ext.length);
  // sanitizeFileName может добавить апостроф к обрезанной основе — на него оставлен один символ.
  return `${sanitizeFileName(base, FILE_NAME_MAX - 1 - ext.length)}${ext}`;
};

/**
 * Проверить присланные файлы по байтам (тип, расширение и MIME согласованы) и подготовить имена.
 * Не прошёл хоть один — ошибка с его именем, в R2 ничего не уходит.
 */
export const prepareSupplementFiles = (
  files: readonly Express.Multer.File[],
): { ok: true; files: IPreparedSupplementFile[] } | { ok: false; error: string } => {
  const prepared: IPreparedSupplementFile[] = [];
  for (const file of files) {
    const decoded = decodeMulterFilename(file.originalname);
    const type = file.size > 0 ? detectMemoFileType(file.buffer, decoded, file.mimetype) : null;
    if (!type) return { ok: false, error: `Файл «${sanitizeFileName(decoded, 80)}»: ${TYPES_HINT}` };
    const ext = decoded.slice(decoded.lastIndexOf('.')).toLowerCase();
    prepared.push({
      buffer: file.buffer,
      fileName: supplementFileName(decoded, ext),
      ext,
      fileSize: file.size,
      mimeType: type.mime,
    });
  }
  return { ok: true, files: prepared };
};

/** Загрузка в R2 не удалась (уже загруженные этим запросом — удалены). */
export class SupplementFileUploadError extends Error {
  constructor(readonly fileName: string, cause: unknown) {
    super(`Не удалось загрузить файл «${fileName}»`, { cause });
    this.name = 'SupplementFileUploadError';
  }
}

/** Удалить объекты R2 best-effort: сбой — в лог и Sentry, объект остаётся сиротой. */
export const deleteSupplementObjects = async (keys: readonly string[]): Promise<void> => {
  for (const key of keys) {
    try {
      await r2Service.deleteObject(key);
    } catch (error) {
      console.warn('[payroll-supplement-files] объект R2 не удалён:', key, error);
      Sentry.captureException(error, { tags: { area: 'payroll-supplement-files' }, extra: { key } });
    }
  }
};

/**
 * Загрузить файлы в R2 по одному. Упал N-й — удаляются уже загруженные и бросается SupplementFileUploadError.
 */
export const uploadSupplementFiles = async (
  employeeId: number,
  files: readonly IPreparedSupplementFile[],
): Promise<INewOneTimeSupplementFile[]> => {
  const uploaded: INewOneTimeSupplementFile[] = [];
  for (const file of files) {
    const r2Key = r2Service.generatePayrollSupplementKey(employeeId, file.ext);
    try {
      await r2Service.uploadObject(r2Key, file.buffer, file.mimeType);
    } catch (error) {
      await deleteSupplementObjects(uploaded.map(item => item.r2Key));
      throw new SupplementFileUploadError(file.fileName, error);
    }
    uploaded.push({ r2Key, fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType });
  }
  return uploaded;
};
