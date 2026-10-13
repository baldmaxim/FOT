import { describe, expect, it } from 'vitest';
import { RECOGNIZABLE_MIME, resolveUploadMime } from './hr-documents.service.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const jpeg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const zip = (): Buffer => Buffer.concat([Buffer.from('PK\u0003\u0004', 'binary'), Buffer.alloc(16)]);

describe('resolveUploadMime', () => {
  it('сигнатура важнее объявленного типа', () => {
    expect(resolveUploadMime(jpeg(), DOCX, new Set([DOCX]))).toBe('image/jpeg');
  });

  it('офисный файл принимается, когда тип разрешён явно', () => {
    expect(resolveUploadMime(zip(), DOCX, new Set([DOCX]))).toBe(DOCX);
  });

  it('без разрешения офисный файл не проходит', () => {
    expect(resolveUploadMime(zip(), DOCX)).toBeNull();
  });

  it('объявленному типу без сигнатуры не верим', () => {
    expect(resolveUploadMime(zip(), 'image/jpeg')).toBeNull();
  });
});

describe('RECOGNIZABLE_MIME', () => {
  it('офисные типы в распознавание не попадают', () => {
    expect(RECOGNIZABLE_MIME.has(DOCX)).toBe(false);
    expect(RECOGNIZABLE_MIME.has('application/pdf')).toBe(true);
    expect(RECOGNIZABLE_MIME.has('image/jpeg')).toBe(true);
  });
});
