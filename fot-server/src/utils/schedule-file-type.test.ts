import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { detectScheduleFileType, scheduleFileName } from './schedule-file-type.js';

/**
 * Файлы графиков (миграция 376): тип — по содержимому. Офисные файлы — по структуре контейнера:
 * у DOC и XLS одна сигнатура OLE2, у DOCX и XLSX — ZIP, поэтому смотрятся потоки и записи, а не строки.
 */

const DOC_MIME = 'application/msword';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLS_MIME = 'application/vnd.ms-excel';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const bytes = (...values: number[]): Buffer => Buffer.from(values);
const withTail = (head: Buffer, size = 64): Buffer => Buffer.concat([head, Buffer.alloc(size)]);

const PDF = withTail(Buffer.from('%PDF-1.7\n'));
const JPEG = withTail(bytes(0xff, 0xd8, 0xff, 0xe0));
const PNG = withTail(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
const WEBP = withTail(Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBPVP8 ')]));

const book = (): XLSX.WorkBook => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Смена', '09:00-18:00']]), 'График');
  return wb;
};
const XLSX_FILE = XLSX.write(book(), { type: 'buffer', bookType: 'xlsx' }) as Buffer;
// BIFF8 — OLE2 с потоком Workbook.
const XLS_FILE = XLSX.write(book(), { type: 'buffer', bookType: 'biff8' }) as Buffer;

interface ICfbUtils {
  utils: {
    cfb_new: () => unknown;
    cfb_add: (container: unknown, name: string, content: Buffer) => void;
  };
  write: (container: unknown, options: { type: 'buffer' }) => Buffer;
}
const cfb = XLSX.CFB as ICfbUtils;

/** OLE2-контейнер с заданными потоками: DOC — WordDocument + 1Table. */
const oleWith = (...streams: string[]): Buffer => {
  const container = cfb.utils.cfb_new();
  for (const name of streams) cfb.utils.cfb_add(container, name, Buffer.from(`${name}-content`));
  return Buffer.from(cfb.write(container, { type: 'buffer' }));
};
const DOC_FILE = oleWith('WordDocument', '1Table');

const zipWith = async (entries: Record<string, string>): Promise<Buffer> => {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  // STORE — содержимое лежит в архиве как есть: строка из него видна в байтах.
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
};

describe('detectScheduleFileType: разрешённые типы', () => {
  it.each([
    ['PDF', PDF, 'приказ.pdf', 'application/pdf', 'application/pdf', '.pdf'],
    ['JPG', JPEG, 'скан.jpg', 'image/jpeg', 'image/jpeg', '.jpg'],
    ['JPEG', JPEG, 'скан.jpeg', 'image/jpeg', 'image/jpeg', '.jpeg'],
    ['PNG', PNG, 'скан.png', 'image/png', 'image/png', '.png'],
    ['WEBP', WEBP, 'скан.webp', 'image/webp', 'image/webp', '.webp'],
    ['XLSX', XLSX_FILE, 'график.xlsx', XLSX_MIME, XLSX_MIME, '.xlsx'],
    ['XLS', XLS_FILE, 'график.xls', XLS_MIME, XLS_MIME, '.xls'],
    ['DOC', DOC_FILE, 'приказ.doc', DOC_MIME, DOC_MIME, '.doc'],
  ])('%s распознан', async (_label, buffer, name, declared, mime, ext) => {
    expect(await detectScheduleFileType(buffer, name, declared)).toEqual({ mime, ext });
  });

  it('DOCX с настоящей записью word/document.xml', async () => {
    const docx = await zipWith({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' });
    expect(await detectScheduleFileType(docx, 'приказ.docx', DOCX_MIME)).toEqual({ mime: DOCX_MIME, ext: '.docx' });
  });

  it('расширение в верхнем регистре: тип и расширение — в нижнем', async () => {
    expect(await detectScheduleFileType(PDF, 'ПРИКАЗ.PDF', 'application/pdf')).toEqual({ mime: 'application/pdf', ext: '.pdf' });
    expect(await detectScheduleFileType(XLSX_FILE, 'ГРАФИК.XLSX', XLSX_MIME)).toEqual({ mime: XLSX_MIME, ext: '.xlsx' });
  });

  it.each(['', 'application/octet-stream'])('общий MIME «%s» не считается подделкой', async (declared) => {
    expect(await detectScheduleFileType(XLSX_FILE, 'график.xlsx', declared)).toEqual({ mime: XLSX_MIME, ext: '.xlsx' });
    expect(await detectScheduleFileType(XLS_FILE, 'график.xls', declared)).toEqual({ mime: XLS_MIME, ext: '.xls' });
    expect(await detectScheduleFileType(DOC_FILE, 'приказ.doc', declared)).toEqual({ mime: DOC_MIME, ext: '.doc' });
  });
});

describe('detectScheduleFileType: отклоняется', () => {
  it('DOC под видом .xls', async () => {
    expect(await detectScheduleFileType(DOC_FILE, 'график.xls', XLS_MIME)).toBeNull();
    expect(await detectScheduleFileType(DOC_FILE, 'график.xls', 'application/octet-stream')).toBeNull();
  });

  it('XLS под видом .doc', async () => {
    expect(await detectScheduleFileType(XLS_FILE, 'приказ.doc', DOC_MIME)).toBeNull();
  });

  it('XLSX под видом .docx и DOCX под видом .xlsx', async () => {
    const docx = await zipWith({ 'word/document.xml': '<w:document/>' });
    expect(await detectScheduleFileType(XLSX_FILE, 'приказ.docx', DOCX_MIME)).toBeNull();
    expect(await detectScheduleFileType(docx, 'график.xlsx', XLSX_MIME)).toBeNull();
  });

  it('ZIP, где строка xl/workbook.xml — только в содержимом, а записи нет', async () => {
    const fake = await zipWith({ 'readme.txt': 'xl/workbook.xml word/document.xml' });
    expect(fake.includes('xl/workbook.xml', 0, 'latin1')).toBe(true);
    expect(await detectScheduleFileType(fake, 'график.xlsx', XLSX_MIME)).toBeNull();
    expect(await detectScheduleFileType(fake, 'приказ.docx', DOCX_MIME)).toBeNull();
  });

  it('OLE2 без потока книги и без WordDocument', async () => {
    const other = oleWith('Contents');
    expect(await detectScheduleFileType(other, 'график.xls', XLS_MIME)).toBeNull();
    expect(await detectScheduleFileType(other, 'приказ.doc', DOC_MIME)).toBeNull();
  });

  it('обрезанный OLE2 и битый ZIP', async () => {
    expect(await detectScheduleFileType(XLS_FILE.subarray(0, 600), 'график.xls', XLS_MIME)).toBeNull();
    expect(await detectScheduleFileType(XLSX_FILE.subarray(0, 40), 'график.xlsx', XLSX_MIME)).toBeNull();
  });

  it('HTML под видом .pdf', async () => {
    expect(await detectScheduleFileType(withTail(Buffer.from('<html><script>')), 'приказ.pdf', 'application/pdf')).toBeNull();
  });

  it('присланный MIME противоречит типу', async () => {
    expect(await detectScheduleFileType(XLSX_FILE, 'график.xlsx', 'text/html')).toBeNull();
    expect(await detectScheduleFileType(XLS_FILE, 'график.xls', DOC_MIME)).toBeNull();
    expect(await detectScheduleFileType(PDF, 'приказ.pdf', 'image/png')).toBeNull();
  });

  it('тип не из списка: txt, svg, без расширения, пустой файл', async () => {
    expect(await detectScheduleFileType(Buffer.from('текст'), 'заметка.txt', 'text/plain')).toBeNull();
    expect(await detectScheduleFileType(Buffer.from('<svg/>'), 'схема.svg', 'image/svg+xml')).toBeNull();
    expect(await detectScheduleFileType(PDF, 'приказ', 'application/pdf')).toBeNull();
    expect(await detectScheduleFileType(Buffer.alloc(0), 'приказ.pdf', 'application/pdf')).toBeNull();
  });
});

describe('scheduleFileName', () => {
  it('имя длиннее 200 символов укорачивается, расширение остаётся', () => {
    const decoded = `${'Приказ о графике '.repeat(20)}.PDF`;
    const name = scheduleFileName(decoded, '.pdf');
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name.startsWith('Приказ о графике')).toBe(true);
  });

  it('недопустимые символы — «_», путь отбрасывается', () => {
    expect(scheduleFileName('../../etc/при:каз*.docx', '.docx')).toBe('при_каз_.docx');
  });

  it('пустая основа — «file»', () => {
    expect(scheduleFileName('.xlsx', '.xlsx')).toBe('file.xlsx');
  });
});
