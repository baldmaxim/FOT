import { describe, expect, it } from 'vitest';
import { detectMemoFileType } from './file-validation.utils.js';

/**
 * Тип служебной записки определяется по байтам, а не по MIME от клиента.
 * Иначе `image/*` пропустил бы SVG со скриптом, а переименованный HTML
 * сохранился бы как PDF.
 */
const bytes = (...values: number[]): Buffer => Buffer.from(values);
const withTail = (head: Buffer, size = 64): Buffer => Buffer.concat([head, Buffer.alloc(size)]);

const PDF = withTail(Buffer.from('%PDF-1.7\n'));
const JPEG = withTail(bytes(0xff, 0xd8, 0xff, 0xe0));
const PNG = withTail(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
const WEBP = withTail(Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBPVP8 ')]));
const OLE = withTail(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1));
const DOCX = Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04), Buffer.from('....word/document.xml....'), Buffer.alloc(32)]);
const PLAIN_ZIP = Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04), Buffer.from('....readme.txt....'), Buffer.alloc(32)]);
const XLSX_ZIP = Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04), Buffer.from('....xl/workbook.xml....'), Buffer.alloc(32)]);

describe('detectMemoFileType: разрешённые типы', () => {
  it.each([
    ['PDF', PDF, 'записка.pdf', 'application/pdf', 'application/pdf', true],
    ['JPEG', JPEG, 'скан.jpg', 'image/jpeg', 'image/jpeg', true],
    ['JPEG .jpeg', JPEG, 'скан.JPEG', 'image/jpeg', 'image/jpeg', true],
    ['PNG', PNG, 'скан.png', 'image/png', 'image/png', true],
    ['WebP', WEBP, 'скан.webp', 'image/webp', 'image/webp', true],
    ['DOC', OLE, 'записка.doc', 'application/msword', 'application/msword', false],
    ['DOCX', DOCX, 'записка.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', false],
  ])('%s распознан', (_label, buffer, name, declared, expectedMime, previewable) => {
    const result = detectMemoFileType(buffer, name, declared);
    expect(result).not.toBeNull();
    expect(result?.mime).toBe(expectedMime);
    expect(result?.previewable).toBe(previewable);
  });

  it('общий octet-stream от браузера не считается подделкой', () => {
    expect(detectMemoFileType(DOCX, 'записка.docx', 'application/octet-stream')?.kind).toBe('docx');
    expect(detectMemoFileType(PDF, 'записка.pdf', '')?.kind).toBe('pdf');
  });

  it('сохраняется MIME сервера, а не клиента', () => {
    // Клиент прислал вариант image/jpg — в БД уйдёт канонический image/jpeg.
    expect(detectMemoFileType(JPEG, 'скан.jpg', 'image/jpg')?.mime).toBe('image/jpeg');
  });
});

describe('detectMemoFileType: отклоняется', () => {
  it('SVG — даже с расширением и MIME изображения', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(detectMemoFileType(svg, 'скан.svg', 'image/svg+xml')).toBeNull();
    expect(detectMemoFileType(svg, 'скан.png', 'image/png')).toBeNull();
  });

  it('HTML, переименованный в .pdf', () => {
    const html = Buffer.from('<!DOCTYPE html><html><body>x</body></html>');
    expect(detectMemoFileType(html, 'записка.pdf', 'application/pdf')).toBeNull();
  });

  it('исполняемый файл', () => {
    const exe = withTail(Buffer.from('MZ'));
    expect(detectMemoFileType(exe, 'записка.exe', 'application/x-msdownload')).toBeNull();
    expect(detectMemoFileType(exe, 'записка.pdf', 'application/pdf')).toBeNull();
  });

  it('байты не совпадают с расширением: PNG под именем .pdf', () => {
    expect(detectMemoFileType(PNG, 'записка.pdf', 'application/octet-stream')).toBeNull();
  });

  it('присланный MIME противоречит байтам: image/png при PDF', () => {
    expect(detectMemoFileType(PDF, 'записка.pdf', 'image/png')).toBeNull();
  });

  it('ZIP без word/document.xml — не DOCX', () => {
    expect(detectMemoFileType(PLAIN_ZIP, 'записка.docx', 'application/octet-stream')).toBeNull();
    expect(detectMemoFileType(XLSX_ZIP, 'записка.docx', 'application/octet-stream')).toBeNull();
  });

  it('OLE-контейнер с расширением .xls — не записка', () => {
    expect(detectMemoFileType(OLE, 'таблица.xls', 'application/vnd.ms-excel')).toBeNull();
  });

  it('файл без расширения', () => {
    expect(detectMemoFileType(PDF, 'записка', 'application/pdf')).toBeNull();
  });

  it('пустой буфер', () => {
    expect(detectMemoFileType(Buffer.alloc(0), 'записка.pdf', 'application/pdf')).toBeNull();
  });
});
