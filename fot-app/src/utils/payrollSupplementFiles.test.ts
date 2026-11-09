import { describe, expect, it } from 'vitest';

import { isPreviewableSupplementFile, supplementFilesError } from './payrollSupplementFiles';

const MB = 1024 * 1024;
const file = (name: string, size = 100) => ({ name, size });

describe('supplementFilesError', () => {
  it('допустимые типы — регистр расширения не важен', () => {
    expect(supplementFilesError([file('Приказ.PDF'), file('Чек.jpeg'), file('Служебка.docx')], 0, [])).toBeNull();
  });

  it('тип, пустой файл, больше 25 МБ — с именем файла', () => {
    expect(supplementFilesError([file('Расчёт.xlsx')], 0, [])).toBe('Файл «Расчёт.xlsx»: допустимы PDF, JPG, PNG, WEBP, DOC, DOCX');
    expect(supplementFilesError([file('без расширения')], 0, [])).toContain('допустимы');
    expect(supplementFilesError([file('Пусто.pdf', 0)], 0, [])).toBe('Файл «Пусто.pdf» пустой');
    expect(supplementFilesError([file('Скан.pdf', 25 * MB + 1)], 0, [])).toBe('Файл «Скан.pdf» больше 25 МБ');
  });

  it('не больше 10 вместе с прикреплёнными и выбранными; не больше 50 МБ новых', () => {
    expect(supplementFilesError([file('a.pdf')], 9, [])).toBeNull();
    expect(supplementFilesError([file('a.pdf')], 8, [file('b.pdf'), file('c.pdf')])).toBe('Не больше 10 файлов');
    expect(supplementFilesError([file('a.pdf', 20 * MB)], 0, [file('b.pdf', 20 * MB)])).toBeNull();
    expect(supplementFilesError([file('a.pdf', 20 * MB)], 0, [file('b.pdf', 20 * MB), file('c.pdf', 11 * MB)]))
      .toBe('Не больше 50 МБ за одно сохранение');
  });
});

describe('isPreviewableSupplementFile', () => {
  it('PDF и картинки — просмотр, Word — скачивание', () => {
    expect(isPreviewableSupplementFile('application/pdf')).toBe(true);
    expect(isPreviewableSupplementFile('image/webp')).toBe(true);
    expect(isPreviewableSupplementFile('application/msword')).toBe(false);
    expect(isPreviewableSupplementFile('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
  });
});
