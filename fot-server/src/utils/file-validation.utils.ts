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
