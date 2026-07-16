import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 1),
}));
vi.mock('./encryption.service.js', () => ({
  encryptionService: { encrypt: (v: string) => `enc:${v}`, decryptField: (v: string | null) => v },
}));
vi.mock('./mts-business-cdr.service.js', () => ({
  mtsBusinessCdrService: {},
  msisdnHash: (m: string | null) => (m ? `h${m}` : null),
  normalizeMsisdn: (m: string | null) => m,
}));

import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { query, queryOne, execute } from '../config/postgres.js';

const queryMock = vi.mocked(query);
const queryOneMock = vi.mocked(queryOne);
const executeMock = vi.mocked(execute);

type EmployeeRow = { id: number; employment_status: string | null; is_archived: boolean };

/** SELECT по ФИО в resolveEmployeeIdByFio отдаёт подготовленных сотрудников. */
const employeesByFio = (rows: EmployeeRow[]): void => {
  queryMock.mockImplementation(async (sql: string) =>
    (sql.includes('FROM employees') ? rows : []) as never);
};

/** id из UPDATE-привязки (второй параметр запроса), если привязка была. */
const linkedEmployeeId = (): number | null => {
  const call = executeMock.mock.calls.find(([sql]) => String(sql).includes('SET employee_id'));
  return call ? (call[1] as unknown[])[1] as number : null;
};

describe('syncMtsNames: автопривязка по ФИО (resolveEmployeeIdByFio)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(1);
  });

  it('единственный активный — привязывается', async () => {
    employeesByFio([{ id: 7, employment_status: 'active', is_archived: false }]);
    const res = await mtsBusinessMappingService.syncMtsNames([{ msisdn: '79001112233', fio: 'Иванов Иван' }], null);
    expect(res).toEqual({ saved: 1, autoLinked: 1, changes: [] });
    expect(linkedEmployeeId()).toBe(7);
  });

  it('активный + уволенный дубль — привязывается активный (дубль не ломает автосвязь)', async () => {
    employeesByFio([
      { id: 5, employment_status: 'fired', is_archived: false },
      { id: 9, employment_status: 'active', is_archived: false },
    ]);
    const res = await mtsBusinessMappingService.syncMtsNames([{ msisdn: '79001112233', fio: 'Иванов Иван' }], null);
    expect(res.autoLinked).toBe(1);
    expect(linkedEmployeeId()).toBe(9);
  });

  it('два активных тёзки — неоднозначно, привязки нет', async () => {
    employeesByFio([
      { id: 5, employment_status: 'active', is_archived: false },
      { id: 9, employment_status: 'active', is_archived: false },
    ]);
    const res = await mtsBusinessMappingService.syncMtsNames([{ msisdn: '79001112233', fio: 'Иванов Иван' }], null);
    expect(res).toEqual({ saved: 1, autoLinked: 0, changes: [] });
    expect(linkedEmployeeId()).toBeNull();
  });

  it('единственное совпадение-уволенный — привязывается (видно, чей номер)', async () => {
    employeesByFio([{ id: 3, employment_status: 'fired', is_archived: false }]);
    const res = await mtsBusinessMappingService.syncMtsNames([{ msisdn: '79001112233', fio: 'Иванов Иван' }], null);
    expect(res.autoLinked).toBe(1);
    expect(linkedEmployeeId()).toBe(3);
  });

  it('совпадений нет — сохраняем ФИО без привязки', async () => {
    employeesByFio([]);
    const res = await mtsBusinessMappingService.syncMtsNames([{ msisdn: '79001112233', fio: 'Неизвестный' }], null);
    expect(res).toEqual({ saved: 1, autoLinked: 0, changes: [] });
  });
});

describe('syncMtsNames / syncMtsComments: diff для «Лога синхронизации»', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(1);
  });

  const prevNames = (rows: Array<{ msisdn_hash: string; mts_fio: string | null; employee_id: number | null }>): void => {
    queryMock.mockImplementation(async (sql: string) =>
      (String(sql).includes('mts_business_number_map') ? rows : []) as never);
  };

  it('старое ФИО отличается → change со старым/новым и привязкой', async () => {
    prevNames([{ msisdn_hash: 'h79001112233', mts_fio: 'Старов Стар', employee_id: 42 }]);
    const res = await mtsBusinessMappingService.syncMtsNames([{ msisdn: '79001112233', fio: 'Новиков Новый' }], null);
    expect(res.changes).toEqual([
      { msisdn: '79001112233', oldFio: 'Старов Стар', newFio: 'Новиков Новый', linkedEmployeeId: 42 },
    ]);
  });

  it('первичное заполнение (старого ФИО нет) и совпадение — не изменение', async () => {
    prevNames([
      { msisdn_hash: 'h79001112233', mts_fio: null, employee_id: null },
      { msisdn_hash: 'h79004445566', mts_fio: 'Иванов Иван', employee_id: null },
    ]);
    const res = await mtsBusinessMappingService.syncMtsNames([
      { msisdn: '79001112233', fio: 'Первый Раз' },
      { msisdn: '79004445566', fio: 'Иванов  Иван' }, // лишний пробел нормализуется
    ], null);
    expect(res.changes).toEqual([]);
  });

  it('syncMtsComments: изменение комментария попадает в changes', async () => {
    queryMock.mockImplementation(async (sql: string) =>
      (String(sql).includes('mts_business_number_map')
        ? [{ msisdn_hash: 'h79001112233', mts_comment: 'старый' }]
        : []) as never);
    const res = await mtsBusinessMappingService.syncMtsComments([{ msisdn: '79001112233', comment: 'новый' }], 'acc');
    expect(res.changes).toEqual([{ msisdn: '79001112233', oldComment: 'старый', newComment: 'новый' }]);
  });
});

describe('setPersonalDataBlob: детект изменения ПДн по хэшу plaintext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(1);
  });

  it('старый хэш есть и отличается → changed=true, UPDATE пишет новый хэш', async () => {
    queryOneMock.mockResolvedValue({ pd_data_hash: 'oldhash' } as never);
    const res = await mtsBusinessMappingService.setPersonalDataBlob('79001112233', 'cipher', 'newhash');
    expect(res).toEqual({ changed: true });
    const upd = executeMock.mock.calls.find(([sql]) => String(sql).includes('SET pd_data_enc'));
    expect(upd![1]).toEqual(['h79001112233', 'cipher', 'newhash']);
  });

  it('первичное заполнение (старого хэша нет) → changed=false', async () => {
    queryOneMock.mockResolvedValue({ pd_data_hash: null } as never);
    const res = await mtsBusinessMappingService.setPersonalDataBlob('79001112233', 'cipher', 'newhash');
    expect(res).toEqual({ changed: false });
  });

  it('хэш совпадает → changed=false', async () => {
    queryOneMock.mockResolvedValue({ pd_data_hash: 'same' } as never);
    const res = await mtsBusinessMappingService.setPersonalDataBlob('79001112233', 'cipher', 'same');
    expect(res).toEqual({ changed: false });
  });
});

type NumberRow = {
  msisdn_hash: string;
  msisdn_enc: string | null;
  mts_fio: string;
  employee_id: number | null;
  current_name: string | null;
};
type EmpMatch = { id: number; full_name: string; tab_number: string | null; employment_status: string | null; is_archived: boolean };

/** Мок для autoLinkByFio: строки number_map + совпадения employees по ФИО. */
const setupAutoLink = (numberRows: NumberRow[], employeeMatches: EmpMatch[]): void => {
  queryMock.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.includes('mts_business_number_map')) return numberRows as never;
    if (s.includes('FROM employees')) return employeeMatches as never;
    return [] as never;
  });
};

/** Все UPDATE-привязки: [msisdn_hash, targetId|null]. Снятие (employee_id = NULL) → null. */
const linkUpdates = (): Array<[string, number | null]> =>
  executeMock.mock.calls
    .filter(([sql]) => String(sql).includes('SET employee_id'))
    .map(([sql, params]) => {
      const p = params as unknown[];
      const target = String(sql).includes('employee_id = NULL') ? null : (p[1] as number);
      return [p[0] as string, target];
    });

describe('autoLinkByFio: пересвязка по всем + конфликты', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(1);
  });

  it('несовпадающая привязка + единственный активный → relinked, сотрудник заменён', async () => {
    setupAutoLink(
      [{ msisdn_hash: 'h1', msisdn_enc: '+79000000001', mts_fio: 'Смолина Ольга Викторовна', employee_id: 100, current_name: 'Сычёв Игорь Алексеевич' }],
      [{ id: 50, full_name: 'Смолина Ольга Викторовна', tab_number: 'T50', employment_status: 'active', is_archived: false }],
    );
    const res = await mtsBusinessMappingService.autoLinkByFio('u1');
    expect(res).toMatchObject({ checked: 1, linked: 0, relinked: 1, cleared: 0 });
    expect(res.conflicts).toHaveLength(0);
    expect(linkUpdates()).toEqual([['h1', 50]]);
  });

  it('совпадающая привязка → не тронута, БД не пишем', async () => {
    setupAutoLink(
      [{ msisdn_hash: 'h1', msisdn_enc: '+79000000001', mts_fio: 'Иванов Иван', employee_id: 7, current_name: 'Иванов Иван' }],
      [],
    );
    const res = await mtsBusinessMappingService.autoLinkByFio('u1');
    expect(res).toMatchObject({ checked: 1, linked: 0, relinked: 0, cleared: 0 });
    expect(res.conflicts).toHaveLength(0);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('чужая привязка + 0 совпадений → cleared + конфликт no_match', async () => {
    setupAutoLink(
      [{ msisdn_hash: 'h1', msisdn_enc: '+79000000001', mts_fio: 'Боровик Александра Петровна', employee_id: 100, current_name: 'Сычёв Игорь Алексеевич' }],
      [],
    );
    const res = await mtsBusinessMappingService.autoLinkByFio('u1');
    expect(res).toMatchObject({ checked: 1, linked: 0, relinked: 0, cleared: 1 });
    expect(linkUpdates()).toEqual([['h1', null]]);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toMatchObject({ msisdn: '+79000000001', reason: 'no_match', currentEmployeeId: 100, candidates: [] });
  });

  it('чужая привязка + несколько однофамильцев → cleared + конфликт ambiguous с кандидатами', async () => {
    setupAutoLink(
      [{ msisdn_hash: 'h1', msisdn_enc: '+79000000001', mts_fio: 'Иванов Иван', employee_id: 100, current_name: 'Сычёв Игорь' }],
      [
        { id: 5, full_name: 'Иванов Иван', tab_number: 'T5', employment_status: 'active', is_archived: false },
        { id: 9, full_name: 'Иванов Иван', tab_number: 'T9', employment_status: 'active', is_archived: false },
      ],
    );
    const res = await mtsBusinessMappingService.autoLinkByFio('u1');
    expect(res).toMatchObject({ cleared: 1 });
    expect(linkUpdates()).toEqual([['h1', null]]);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].reason).toBe('ambiguous');
    expect(res.conflicts[0].candidates).toHaveLength(2);
  });

  it('не привязан + единственный активный → linked (прежнее поведение)', async () => {
    setupAutoLink(
      [{ msisdn_hash: 'h1', msisdn_enc: '+79000000001', mts_fio: 'Петров Пётр', employee_id: null, current_name: null }],
      [{ id: 42, full_name: 'Петров Пётр', tab_number: null, employment_status: 'active', is_archived: false }],
    );
    const res = await mtsBusinessMappingService.autoLinkByFio('u1');
    expect(res).toMatchObject({ checked: 1, linked: 1, relinked: 0, cleared: 0 });
    expect(res.conflicts).toHaveLength(0);
    expect(linkUpdates()).toEqual([['h1', 42]]);
  });

  it('не привязан + 0 совпадений → без конфликта и без записи', async () => {
    setupAutoLink(
      [{ msisdn_hash: 'h1', msisdn_enc: '+79000000001', mts_fio: 'Неизвестный Абонент', employee_id: null, current_name: null }],
      [],
    );
    const res = await mtsBusinessMappingService.autoLinkByFio('u1');
    expect(res).toMatchObject({ checked: 1, linked: 0, relinked: 0, cleared: 0 });
    expect(res.conflicts).toHaveLength(0);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
