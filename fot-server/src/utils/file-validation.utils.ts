// Magic-bytes проверка для xlsx/xls. multer-fileFilter валидирует только
// MIME, который контролирует клиент — переименованный .exe с MIME
// `application/octet-stream` проходил бы фильтр по расширению. Здесь смотрим
// первые байты буфера и отсекаем подделки до тяжёлого парсинга.
//
// xlsx — это zip-контейнер: PK\x03\x04
// xls  — старый OLE2 compound: D0 CF 11 E0 A1 B1 1A E1
const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const XLS_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export function isXlsxBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(XLSX_MAGIC);
}

export function isXlsBuffer(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(XLS_MAGIC);
}

export function isExcelBuffer(buffer: Buffer): boolean {
  return isXlsxBuffer(buffer) || isXlsBuffer(buffer);
}

// ─── Служебные записки: тип по содержимому ──────────────────────────────────
//
// file.mimetype присылает клиент, а `image/*` пропустил бы SVG со скриптом.
// Поэтому тип определяется по первым байтам, и он обязан совпасть с расширением
// и присланным MIME. Явный список — всё остальное (SVG, HTML, текст) отклоняется.

export type MemoFileKind = 'pdf' | 'jpeg' | 'png' | 'webp' | 'doc' | 'docx';

export interface IMemoFileType {
  kind: MemoFileKind;
  /** MIME, который сохраняется в БД и в ContentType объекта R2. */
  mime: string;
  /** Можно ли отдавать inline (предпросмотр в браузере). */
  previewable: boolean;
}

interface IMemoTypeRule {
  kind: MemoFileKind;
  mime: string;
  extensions: readonly string[];
  /** Какие MIME от клиента считаются согласованными с этим типом. */
  declared: readonly string[];
  previewable: boolean;
  matches: (buffer: Buffer) => boolean;
}

const startsWith = (buffer: Buffer, bytes: readonly number[], offset = 0): boolean =>
  buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b);

// Браузеры и ОС нередко присылают для офисных файлов общий тип — это не подделка.
const GENERIC_DECLARED = ['', 'application/octet-stream'];

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const MEMO_TYPE_RULES: readonly IMemoTypeRule[] = [
  {
    kind: 'pdf', mime: 'application/pdf', extensions: ['.pdf'], previewable: true,
    declared: ['application/pdf', 'application/x-pdf'],
    matches: b => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
  },
  {
    kind: 'jpeg', mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], previewable: true,
    declared: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
    matches: b => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    kind: 'png', mime: 'image/png', extensions: ['.png'], previewable: true,
    declared: ['image/png'],
    matches: b => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    kind: 'webp', mime: 'image/webp', extensions: ['.webp'], previewable: true,
    declared: ['image/webp'],
    // RIFF....WEBP
    matches: b => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  },
  {
    kind: 'doc', mime: 'application/msword', extensions: ['.doc'], previewable: false,
    declared: ['application/msword'],
    // OLE2 — тот же контейнер у .xls, поэтому расширение обязано быть .doc.
    matches: b => isXlsBuffer(b),
  },
  {
    kind: 'docx', mime: DOCX_MIME, extensions: ['.docx'], previewable: false,
    declared: [DOCX_MIME],
    // ZIP сам по себе ничего не доказывает: в DOCX обязательно есть word/document.xml.
    // Имена записей хранятся в ZIP несжатыми, поэтому достаточно поиска байтов.
    matches: b => isXlsxBuffer(b) && b.includes('word/document.xml', 0, 'latin1'),
  },
];

/**
 * Определяет тип служебной записки по байтам. Возвращает null, если сигнатура не
 * из разрешённого списка или не совпадает с расширением либо присланным MIME
 * (например, `.pdf` с байтами HTML или `image/png` при байтах PDF).
 */
export function detectMemoFileType(
  buffer: Buffer,
  fileName: string,
  declaredMime: string | null | undefined,
): IMemoFileType | null {
  const rule = MEMO_TYPE_RULES.find(r => r.matches(buffer));
  if (!rule) return null;

  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  if (!rule.extensions.includes(ext)) return null;

  const declared = (declaredMime ?? '').trim().toLowerCase();
  if (!GENERIC_DECLARED.includes(declared) && !rule.declared.includes(declared)) return null;

  return { kind: rule.kind, mime: rule.mime, previewable: rule.previewable };
}

// Очищает имя файла от управляющих и опасных символов перед сохранением в
// БД/R2. Защищает от: path traversal (`../`), null-byte, контрольных символов,
// CSV-injection префиксов в Excel-export (`=`, `+`, `-`, `@`, табуляция).
// Сохраняет любые Unicode-буквы и цифры (\p{L}\p{N}), пробелы, точки,
// дефис, подчёркивание, скобки, плюс и знак №.
export function sanitizeFileName(name: string, maxLength = 200): string {
  // path.basename + удаление NUL и control-chars
  const base = name.replace(/^.*[\\/]/, '').replace(/[\x00-\x1f\x7f]/g, '');
  // Запрещённые символы заменяем на _ (всё, что не буква/цифра Unicode и
  // не из разрешённой пунктуации). Файлы с диакритикой, № и т.п. не теряются.
  let cleaned = base.replace(/[^\p{L}\p{N}.\-_ ()+№]/gu, '_').slice(0, maxLength);
  // Defang CSV-injection: префиксы =, +, -, @, табуляция в начале → апостроф
  if (/^[=+\-@\t\r]/.test(cleaned)) cleaned = `'${cleaned}`;
  return cleaned || 'file';
}

// Префикс для одной ячейки CSV/XLSX-export: если значение начинается с
// формула-триггера, добавляем апостроф. Используется при отдаче пользователь-
// контролируемых строк (file_name, ФИО) в файлах для Excel.
export function defangCsvCell(value: string): string {
  if (!value) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
