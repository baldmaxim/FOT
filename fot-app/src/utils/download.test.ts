import { describe, it, expect } from 'vitest';
import { parseContentDispositionFilename } from './download';

const FALLBACK = 'Сотрудники.xlsx';

describe('parseContentDispositionFilename', () => {
  it('берёт имя из filename* (RFC 5987) и раскодирует кириллицу', () => {
    const header = `attachment; filename*=UTF-8''${encodeURIComponent('Сотрудники_10.09.2026.xlsx')}`;

    expect(parseContentDispositionFilename(header, FALLBACK)).toBe('Сотрудники_10.09.2026.xlsx');
  });

  it('берёт обычный filename, когда filename* нет', () => {
    const header = 'attachment; filename="report.xlsx"';

    expect(parseContentDispositionFilename(header, FALLBACK)).toBe('report.xlsx');
  });

  it('при обоих вариантах предпочитает filename*', () => {
    const encoded = encodeURIComponent('Сотрудники.xlsx');
    const header = `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;

    expect(parseContentDispositionFilename(header, FALLBACK)).toBe('Сотрудники.xlsx');
  });

  it('битый percent-encoding отдаёт как есть, а не падает', () => {
    const header = `attachment; filename*=UTF-8''%E0%A4%A`;

    expect(parseContentDispositionFilename(header, FALLBACK)).toBe('%E0%A4%A');
  });

  it('без заголовка возвращает запасное имя', () => {
    expect(parseContentDispositionFilename(null, FALLBACK)).toBe(FALLBACK);
    expect(parseContentDispositionFilename('attachment', FALLBACK)).toBe(FALLBACK);
  });
});
