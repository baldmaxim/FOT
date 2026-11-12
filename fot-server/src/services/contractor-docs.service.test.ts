import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  normalizeDocNumber,
  isDocsComplete,
  findOrgDocDuplicate,
  duplicateMessage,
  citizenshipRequiresPatent,
  docsBodySchema,
  mergeUnsentDocFields,
  normalizeDocsPayload,
  isRussianCitizenship,
  normalizeKig,
  sameHolderName,
  holderChangeResetsDocuments,
  resetPassDocuments,
  recordDocHistoryIfChanged,
  EMPTY_DOCS,
  type IDocRow,
  type IDocHistoryPass,
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
  it('Туркменистан — патентное гражданство: без патента → false', () => {
    const base = { ...fullDocs, patent_number: null, patent_issue_date: null, patent_blank_number: null };
    expect(isDocsComplete({ ...base, citizenship: 'Туркменистан' })).toBe(false);
    expect(isDocsComplete({ ...fullDocs, citizenship: 'Туркменистан' })).toBe(true);
  });
  it('ВНЖ отменяет патент: патентная страна + ВНЖ с номером → true (без патента)', () => {
    const noPatent = { ...fullDocs, patent_number: null, patent_issue_date: null, patent_blank_number: null };
    expect(isDocsComplete({ ...noPatent, has_residence_permit: true, residence_permit_number: '82№1234567' })).toBe(true);
  });
  it('ВНЖ без номера → false (номер ВНЖ обязателен)', () => {
    const noPatent = { ...fullDocs, patent_number: null, patent_issue_date: null, patent_blank_number: null };
    expect(isDocsComplete({ ...noPatent, has_residence_permit: true, residence_permit_number: '' })).toBe(false);
    expect(isDocsComplete({ ...noPatent, has_residence_permit: true, residence_permit_number: null })).toBe(false);
  });
});

describe('contractor-docs citizenshipRequiresPatent', () => {
  it('Туркменистан требует патент (регистронезависимо)', () => {
    expect(citizenshipRequiresPatent('Туркменистан')).toBe(true);
    expect(citizenshipRequiresPatent(' туркменистан ')).toBe(true);
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

describe('contractor-docs СНИЛС/ИНН/КиГ: разбор и нормализация', () => {
  const base = {
    passport_series_number: '40 12 345678',
    citizenship: 'Таджикистан',
  };

  it('СНИЛС с маской → 11 цифр; ИНН — 12 цифр', () => {
    const next = normalizeDocsPayload(docsBodySchema.parse({ ...base, snils: '123-456-789 00', inn: '7707 0832 8934' }));
    expect(next.snils).toBe('12345678900');
    expect(next.inn).toBe('770708328934');
  });

  it('СНИЛС не из 11 цифр или с буквами → ошибка разбора', () => {
    expect(() => docsBodySchema.parse({ ...base, snils: '123-456-789' })).toThrow('СНИЛС — 11 цифр');
    expect(() => docsBodySchema.parse({ ...base, snils: '123-456-789 0A' })).toThrow('СНИЛС — 11 цифр');
  });

  it('ИНН не из 12 цифр → ошибка разбора (10 цифр — ИНН юрлица)', () => {
    expect(() => docsBodySchema.parse({ ...base, inn: '7707083893' })).toThrow('ИНН — 12 цифр');
  });

  it('пустая строка и null очищают СНИЛС/ИНН', () => {
    const a = normalizeDocsPayload(docsBodySchema.parse({ ...base, snils: '', inn: null }));
    expect(a.snils).toBeNull();
    expect(a.inn).toBeNull();
  });

  it('КиГ иностранца — верхний регистр, должность сохраняется', () => {
    const next = normalizeDocsPayload(docsBodySchema.parse({ ...base, kig: ' ab1234567 ', position: ' бетонщик ' }));
    expect(next.kig).toBe('AB1234567');
    expect(next.position).toBe('бетонщик');
  });

  it('КиГ: кириллица-двойники и пробелы → латиница («АВ 1234567» → AB1234567)', () => {
    const next = normalizeDocsPayload(docsBodySchema.parse({ ...base, kig: 'АВ 1234567' }));
    expect(next.kig).toBe('AB1234567');
    expect(normalizeKig(' ах 12 ')).toBe('AX12');
    expect(normalizeKig('   ')).toBeNull();
  });

  it('КиГ с прочей кириллицей или знаками — ошибка схемы', () => {
    for (const kig of ['ФЫ1234567', 'AB-1234567', 'AB1234567№']) {
      expect(() => docsBodySchema.parse({ ...base, kig })).toThrow('Номер КиГ — только латинские буквы и цифры');
    }
  });

  it('гражданин России (в любом регистре и с пробелами) и пустое гражданство — КиГ обнуляется, должность остаётся', () => {
    for (const citizenship of ['Россия', ' россия ', 'РОССИЯ', '', null]) {
      const next = normalizeDocsPayload(docsBodySchema.parse({
        ...base, citizenship, kig: 'AB1234567', position: 'Бетонщик',
      }));
      expect(next.kig).toBeNull();
      expect(next.position).toBe('Бетонщик');
    }
  });

  it('старый клиент присылает kig_end_date — ключ отбрасывается', () => {
    const next = normalizeDocsPayload(docsBodySchema.parse({ ...base, kig_end_date: '2027-03-01' }));
    expect(Object.hasOwn(next, 'kig_end_date')).toBe(false);
  });

  it('isRussianCitizenship', () => {
    expect(isRussianCitizenship(' россия ')).toBe(true);
    expect(isRussianCitizenship('Казахстан')).toBe(false);
    expect(isRussianCitizenship(null)).toBe(false);
  });
});

describe('contractor-docs mergeUnsentDocFields (старый клиент)', () => {
  const prev: Partial<IDocRow> = {
    citizenship: 'Таджикистан', snils: '12345678900', inn: '770708328934', kig: 'AB1234567', position: 'Бетонщик',
  };

  it('ключей нет в теле → прежние значения из БД', () => {
    const body = { citizenship: 'Таджикистан' };
    const next = normalizeDocsPayload(mergeUnsentDocFields(body, docsBodySchema.parse(body), prev));
    expect(next.snils).toBe('12345678900');
    expect(next.inn).toBe('770708328934');
    expect(next.kig).toBe('AB1234567');
    expect(next.position).toBe('Бетонщик');
  });

  it('явный null / пустая строка → очистка', () => {
    const body = { citizenship: 'Таджикистан', snils: null, inn: '', kig: null, position: '' };
    const next = normalizeDocsPayload(mergeUnsentDocFields(body, docsBodySchema.parse(body), prev));
    expect(next.snils).toBeNull();
    expect(next.inn).toBeNull();
    expect(next.kig).toBeNull();
    expect(next.position).toBeNull();
  });

  it('старый клиент сменил гражданство на Россию — КиГ из БД всё равно обнуляется', () => {
    const body = { citizenship: 'Россия' };
    const next = normalizeDocsPayload(mergeUnsentDocFields(body, docsBodySchema.parse(body), prev));
    expect(next.kig).toBeNull();
    expect(next.position).toBe('Бетонщик');
    expect(next.snils).toBe('12345678900');
  });
});

describe('contractor-docs смена ФИО держателя', () => {
  it('sameHolderName: регистр, пробелы, ё/е', () => {
    expect(sameHolderName(' Иванов  Пётр ', 'иванов петр')).toBe(true);
    expect(sameHolderName('Иванов Пётр', 'Петров Пётр')).toBe(false);
  });

  it('holderChangeResetsDocuments: правила сброса', () => {
    // первичное назначение — документы могли внести заранее
    expect(holderChangeResetsDocuments(null, 'Петров П.', false)).toBe(false);
    expect(holderChangeResetsDocuments('', null, false)).toBe(false);
    // то же ФИО — исправление написания
    expect(holderChangeResetsDocuments('Иванов И.', ' иванов  и. ', false)).toBe(false);
    // другой человек
    expect(holderChangeResetsDocuments('Иванов И.', 'Петров П.', false)).toBe(true);
    // подрядчик подтвердил «опечатка — оставить»
    expect(holderChangeResetsDocuments('Иванов И.', 'Иваноф И.', true)).toBe(false);
    // ФИО стёрто — сброс всегда, флаг не действует
    expect(holderChangeResetsDocuments('Иванов И.', null, true)).toBe(true);
    expect(holderChangeResetsDocuments('Иванов И.', '  ', false)).toBe(true);
  });
});

describe('contractor-docs resetPassDocuments', () => {
  const withDocs: IDocHistoryPass = {
    ...EMPTY_DOCS,
    id: 'p1', pass_number: '64', org_department_id: 'org', holder_name: 'Иванов И.',
    passport_series_number: '403934253', citizenship: 'Таджикистан', snils: '12345678900',
  };
  const empty: IDocHistoryPass = {
    ...EMPTY_DOCS, id: 'p2', pass_number: '65', org_department_id: 'org', holder_name: null,
  };
  const makeClient = (rows: IDocHistoryPass[]) => {
    const q = vi.fn(async (sql: string) => (String(sql).includes('FOR UPDATE') ? { rows } : { rows: [] }));
    return { client: { query: q } as unknown as PoolClient, q };
  };

  it('пустой список — без запросов', async () => {
    const { client, q } = makeClient([]);
    expect(await resetPassDocuments(client, [], { userId: 'u', source: 'holder_reset' })).toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });

  it('блокирует в порядке id, пишет снимок с источником из actor и очищает только строки с документами', async () => {
    const { client, q } = makeClient([withDocs, empty]);
    const ids = await resetPassDocuments(client, ['p2', 'p1'], { userId: 'u', source: 'clear_holder' });
    expect(ids).toEqual(['p1']);

    const select = String(q.mock.calls[0][0]);
    expect(select).toContain('ORDER BY p.id');
    expect(select).toContain('FOR UPDATE OF p');
    expect(select).toContain('valid_until IS NULL');

    const hist = q.mock.calls.filter(c => String(c[0]).includes('contractor_pass_document_history'));
    expect(hist).toHaveLength(1);
    const hp = hist[0][1] as unknown[];
    expect(hp[3]).toBe('Иванов И.');       // прежнее ФИО в снимке
    expect(hp[15]).toBe('clear_holder');   // источник — из actor
    expect(hp[16]).toBe('12345678900');    // прежний СНИЛС

    const upd = q.mock.calls.find(c => String(c[0]).startsWith('UPDATE contractor_passes'));
    expect(String(upd?.[0])).toContain('snils = NULL');
    expect(String(upd?.[0])).toContain('has_residence_permit = false');
    expect(upd?.[1]).toEqual([['p1']]);
  });

  it('документов нет ни у кого — UPDATE не выполняется', async () => {
    const { client, q } = makeClient([empty]);
    expect(await resetPassDocuments(client, ['p2'], { userId: 'u', source: 'holder_reset' })).toEqual([]);
    expect(q.mock.calls.some(c => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });
});

describe('contractor-docs recordDocHistoryIfChanged: новые поля', () => {
  it('смена СНИЛС попадает в changed_fields и в снимок', async () => {
    const q = vi.fn().mockResolvedValue({ rows: [] });
    const prev: IDocHistoryPass = {
      ...EMPTY_DOCS, id: 'p1', pass_number: '64', org_department_id: 'org', holder_name: 'Иванов',
      passport_series_number: '403934253', snils: '12345678900', position: 'Бетонщик',
    };
    const changed = await recordDocHistoryIfChanged(
      { query: q } as unknown as PoolClient, prev,
      { ...prev, snils: '98765432100' },
      { userId: 'u', source: 'admin' },
    );
    expect(changed).toEqual(['snils']);
    const params = q.mock.calls[0][1] as unknown[];
    expect(params[13]).toEqual(['snils']);
    expect(params[16]).toBe('12345678900');
    expect(params[19]).toBe('Бетонщик');
  });
});
