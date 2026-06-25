import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  normalizeDocNumber,
  isDocsComplete,
  findOrgDocDuplicate,
  duplicateMessage,
  type IDocRow,
} from './contractor-docs.service.js';

const fullDocs: IDocRow = {
  passport_series_number: '40 12 345678',
  passport_issue_date: '2015-05-01',
  birth_date: '1990-01-01',
  citizenship: 'Узбекистан',
  patent_number: '77 №2600295204',
  patent_issue_date: '2024-01-10',
  patent_blank_number: 'ПР8048893',
};

describe('contractor-docs normalizeDocNumber', () => {
  it('убирает пробелы/№/пунктуацию и приводит к нижнему регистру', () => {
    expect(normalizeDocNumber('77 №2600295204')).toBe('772600295204');
    expect(normalizeDocNumber('ПР-8048 893')).toBe('пр8048893');
    expect(normalizeDocNumber('40 12 345678')).toBe('4012345678');
  });
  it('пустые/мусорные значения → null', () => {
    expect(normalizeDocNumber('')).toBeNull();
    expect(normalizeDocNumber('   ')).toBeNull();
    expect(normalizeDocNumber(null)).toBeNull();
    expect(normalizeDocNumber('№ - ')).toBeNull();
  });
});

describe('contractor-docs isDocsComplete', () => {
  it('полный комплект патентного гражданина → true', () => {
    expect(isDocsComplete(fullDocs)).toBe(true);
  });
  it('любое пустое базовое поле → false', () => {
    expect(isDocsComplete({ ...fullDocs, birth_date: '' })).toBe(false);
    expect(isDocsComplete(null)).toBe(false);
  });
  it('патентный гражданин без поля патента → false', () => {
    expect(isDocsComplete({ ...fullDocs, patent_blank_number: null })).toBe(false);
    expect(isDocsComplete({ ...fullDocs, patent_number: '' })).toBe(false);
  });
  it('гражданин ЕАЭС/«Другое» без патента → true', () => {
    const base = { ...fullDocs, patent_number: null, patent_issue_date: null, patent_blank_number: null };
    expect(isDocsComplete({ ...base, citizenship: 'Казахстан' })).toBe(true);
    expect(isDocsComplete({ ...base, citizenship: 'Другое' })).toBe(true);
  });
  it('гражданство не выбрано → false (обязательное поле)', () => {
    expect(isDocsComplete({ ...fullDocs, citizenship: null })).toBe(false);
    expect(isDocsComplete({ ...fullDocs, citizenship: '' })).toBe(false);
  });
});

describe('contractor-docs findOrgDocDuplicate', () => {
  const makeClient = (rows: unknown[]): PoolClient =>
    ({ query: vi.fn().mockResolvedValue({ rows }) } as unknown as PoolClient);

  it('нет номеров → null без запроса', async () => {
    const client = makeClient([]);
    const res = await findOrgDocDuplicate(client, {
      orgId: 'org', passId: 'p1', patentNumber: null, passportNumber: null,
    });
    expect(res).toBeNull();
    expect((client.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('возвращает конфликт с ФИО и номером пропуска', async () => {
    const client = makeClient([{ field: 'patent', holder_name: 'Иванов И.И.', pass_number: '123' }]);
    const res = await findOrgDocDuplicate(client, {
      orgId: 'org', passId: 'p1', patentNumber: '77 №2600295204', passportNumber: null,
    });
    expect(res).toEqual({ field: 'patent', holder_name: 'Иванов И.И.', pass_number: '123' });
    expect(duplicateMessage(res!)).toBe('Номер патента уже указан у Иванов И.И. (пропуск №123)');
  });

  it('нормализует номер перед передачей параметром', async () => {
    const client = makeClient([]);
    await findOrgDocDuplicate(client, {
      orgId: 'org', passId: 'p1', patentNumber: '77 №2600295204', passportNumber: '40 12 345678',
    });
    const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toEqual(['org', 'p1', '772600295204', '4012345678']);
  });
});
