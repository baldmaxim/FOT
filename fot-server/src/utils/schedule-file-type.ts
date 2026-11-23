import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { detectMemoFileType, isXlsBuffer, isXlsxBuffer, sanitizeFileName } from './file-validation.utils.js';

// Файлы шаблонов графиков (миграция 376): тип — по содержимому, а не по присланному MIME.
// PDF и картинки — общая проверка служебок (detectMemoFileType, без изменений). Офисные файлы
// разбираются по структуре: у DOC и XLS одна сигнатура OLE2, у DOCX и XLSX — ZIP, поэтому
// смотрим потоки контейнера и записи архива, а не строки в байтах.

export interface IScheduleFileType {
  /** MIME, который сохраняется в БД и в ContentType объекта R2. */
  mime: string;
  /** С точкой, в нижнем регистре: «.pdf». */
  ext: string;
}

export const SCHEDULE_FILE_TYPES_HINT = 'можно PDF, JPG, PNG, WEBP, DOC, DOCX, XLS, XLSX';

/** Длина имени в БД (CHECK миграции 376). */
const FILE_NAME_MAX = 200;

const DOC_MIME = 'application/msword';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLS_MIME = 'application/vnd.ms-excel';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Браузеры и ОС нередко присылают для офисных файлов общий тип — это не подделка.
const GENERIC_DECLARED = ['', 'application/octet-stream'];
const XLS_DECLARED = [XLS_MIME, 'application/excel', 'application/x-excel', 'application/x-msexcel'];

// SheetJS отдаёт CFB как any — берём только нужное.
interface ICfbEntry {
  name: string;
  /** 2 — поток (файл внутри контейнера). */
  type: number;
}
interface ICfbApi {
  read: (data: Buffer, options: { type: 'buffer' }) => { FileIndex: ICfbEntry[] };
}
const cfb = XLSX.CFB as ICfbApi;
const CFB_STREAM = 2;

const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
};

const declaredAllowed = (declaredMime: string | null | undefined, allowed: readonly string[]): boolean => {
  const declared = (declaredMime ?? '').trim().toLowerCase();
  return GENERIC_DECLARED.includes(declared) || allowed.includes(declared);
};

/** Имена потоков OLE2-контейнера; не разобрался — null. */
const oleStreamNames = (buffer: Buffer): Set<string> | null => {
  try {
    const container = cfb.read(buffer, { type: 'buffer' });
    return new Set(container.FileIndex.filter(entry => entry.type === CFB_STREAM).map(entry => entry.name));
  } catch {
    return null;
  }
};

/** Есть ли в ZIP настоящая запись-файл с таким путём (центральный каталог, без распаковки). */
const zipHasFile = async (buffer: Buffer, path: string): Promise<boolean> => {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file(path);
    return entry !== null && !entry.dir;
  } catch {
    return false;
  }
};

/**
 * Тип файла графика по байтам. null — тип не из списка, не совпадает с расширением или присланным MIME,
 * либо контейнер не того вида (DOC под видом .xls, XLS под видом .doc, ZIP без книги Excel).
 */
export async function detectScheduleFileType(
  buffer: Buffer,
  fileName: string,
  declaredMime: string | null | undefined,
): Promise<IScheduleFileType | null> {
  if (buffer.length === 0) return null;
  const ext = extensionOf(fileName);

  switch (ext) {
    case '.pdf':
    case '.jpg':
    case '.jpeg':
    case '.png':
    case '.webp': {
      const type = detectMemoFileType(buffer, fileName, declaredMime);
      return type ? { mime: type.mime, ext } : null;
    }
    case '.docx': {
      if (!isXlsxBuffer(buffer) || !declaredAllowed(declaredMime, [DOCX_MIME])) return null;
      return (await zipHasFile(buffer, 'word/document.xml')) ? { mime: DOCX_MIME, ext } : null;
    }
    case '.xlsx': {
      if (!isXlsxBuffer(buffer) || !declaredAllowed(declaredMime, [XLSX_MIME])) return null;
      return (await zipHasFile(buffer, 'xl/workbook.xml')) ? { mime: XLSX_MIME, ext } : null;
    }
    case '.doc': {
      if (!isXlsBuffer(buffer) || !declaredAllowed(declaredMime, [DOC_MIME])) return null;
      const streams = oleStreamNames(buffer);
      return streams?.has('WordDocument') ? { mime: DOC_MIME, ext } : null;
    }
    case '.xls': {
      if (!isXlsBuffer(buffer) || !declaredAllowed(declaredMime, XLS_DECLARED)) return null;
      const streams = oleStreamNames(buffer);
      if (!streams || streams.has('WordDocument')) return null;
      // BIFF8 — поток Workbook, BIFF5 и старше — Book.
      return streams.has('Workbook') || streams.has('Book') ? { mime: XLS_MIME, ext } : null;
    }
    default:
      return null;
  }
}

/**
 * Имя для БД и скачивания: основа очищается (sanitizeFileName) и укорачивается так, чтобы с расширением
 * влезть в 200 символов, — расширение не теряется. ext — из detectScheduleFileType.
 */
export const scheduleFileName = (decodedName: string, ext: string): string => {
  const base = decodedName.slice(0, decodedName.length - ext.length);
  // sanitizeFileName может добавить апостроф к основе — на него оставлен один символ.
  return `${sanitizeFileName(base, FILE_NAME_MAX - 1 - ext.length)}${ext}`;
};
