import ExcelJS from 'exceljs';

/**
 * Читает первый лист xlsx-файла из буфера и возвращает массив строк (по одной строке на запись таблицы).
 * Пустые ячейки нормализуются в пустые строки — это соответствует поведению xlsx.utils.sheet_to_json с defval: ''.
 */
export async function readExcelRows(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(arrayBuffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const rows: string[][] = [];
  const columnCount = worksheet.columnCount;
  if (columnCount === 0 && worksheet.rowCount === 0) return rows;

  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const flat: string[] = [];
    const width = Math.max(columnCount, (row.cellCount ?? 0));
    for (let col = 1; col <= width; col += 1) {
      const cell = row.getCell(col);
      flat.push(formatCellValue(cell.value));
    }
    rows.push(flat);
  });

  // Убираем хвостовые пустые строки — exceljs присылает полные строки, xlsx их не возвращал.
  while (rows.length > 0 && rows[rows.length - 1].every(value => value === '')) {
    rows.pop();
  }
  return rows;
}

function formatCellValue(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === 'object') {
    // exceljs может вернуть rich text, формулы, гиперссылки — сводим к строке.
    if ('text' in value && typeof (value as { text: unknown }).text === 'string') {
      return (value as { text: string }).text;
    }
    if ('richText' in value && Array.isArray((value as { richText: Array<{ text?: string }> }).richText)) {
      return (value as { richText: Array<{ text?: string }> }).richText
        .map(chunk => chunk.text ?? '')
        .join('');
    }
    if ('result' in value) {
      return formatCellValue((value as { result: ExcelJS.CellValue }).result);
    }
    if ('hyperlink' in value && typeof (value as { hyperlink: unknown }).hyperlink === 'string') {
      return (value as { hyperlink: string }).hyperlink;
    }
  }
  return String(value);
}
