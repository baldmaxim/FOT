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
import { query, execute } from '../config/postgres.js';

const queryMock = vi.mocked(query);
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
    expect(res).toEqual({ saved: 1, autoLinked: 1 });
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
    expect(res).toEqual({ saved: 1, autoLinked: 0 });
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
    expect(res).toEqual({ saved: 1, autoLinked: 0 });
  });
});
