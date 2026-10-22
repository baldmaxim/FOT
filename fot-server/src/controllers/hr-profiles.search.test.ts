import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * «Реквизиты» (HR-профили) → поиск: ФИО — точно (ё = е, раскладка), без точных — с одной ошибкой;
 * СНИЛС/ИНН/паспорт — прежнее точное сравнение хешей и опечатку глушат; фильтр комплектности файлов
 * (после SQL) участвует в решении.
 */

const { h } = vi.hoisted(() => ({
  h: {
    query: vi.fn(),
  },
}));

vi.mock('../config/postgres.js', () => ({ query: h.query, queryOne: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: vi.fn(async () => true),
  canWriteEmployeeInScope: vi.fn(async () => true),
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all'),
  resolveAccessibleEmployeeIds: vi.fn(async () => 'all'),
}));
vi.mock('../services/timekeeper-scope.service.js', () => ({ isTimekeeper: () => false }));
vi.mock('../services/hr-crypto.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/hr-crypto.service.js')>()),
  isHrCryptoConfigured: () => true,
  hashForSearch: (kind: string, value: string) => `hash:${kind}:${value}`,
}));

const { hrProfilesController } = await import('./hr-profiles.controller.js');

interface IRow { employee_id: number; full_name: string; files_count: number }

const row = (employee_id: number, full_name: string, files_count = 0): IRow => ({ employee_id, full_name, files_count });

const call = async (query: Record<string, string>) => {
  const res = {
    statusCode: 200,
    body: null as unknown as { data: Array<{ employee_id: number }>; meta: { total: number } },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body as typeof res.body; return res; },
  };
  await hrProfilesController.list({ query, user: { id: 'u', is_admin: true } } as unknown as AuthenticatedRequest, res as unknown as Response);
  return res;
};

const ids = (res: Awaited<ReturnType<typeof call>>) => res.body.data.map(item => item.employee_id);

/** exact — строки точного SQL, fuzzy — дополнительные строки SQL с опечатками. */
const mockRows = (exact: IRow[], fuzzy: IRow[] = []) => {
  h.query.mockImplementation(async (sql: string) => (sql.includes('unnest(') ? [...exact, ...fuzzy] : exact)
    .map(item => ({ ...item, file_categories: [], open_conflicts: 0, ocr_pending: 0, citizenship_id: null })));
};

beforeEach(() => {
  h.query.mockReset();
});

describe('hrProfilesController.list — поиск', () => {
  it('ФИО: регулярным выражением по индексу (ё = е, раскладка), точное есть — опечаток нет', async () => {
    mockRows([row(1, 'Гринёв Андрей')], [row(2, 'Гринав Олег')]);
    const res = await call({ search: 'uhbyt' });
    expect(ids(res)).toEqual([1]);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(String(h.query.mock.calls[0][0])).toContain('(e.full_name ~* $1 OR e.full_name ~* $2)');
  });

  it('точного нет — с одной ошибкой', async () => {
    mockRows([], [row(2, 'Гринёв Андрей')]);
    expect(ids(await call({ search: 'грнев' }))).toEqual([2]);
    expect(String(h.query.mock.calls[1][0])).toContain('e.id IN (SELECT fz.id FROM unnest(');
  });

  it('точный убран фильтром комплектности файлов — опечатка ищется', async () => {
    // Точный без файлов, вариант с ошибкой — тоже без файлов, но фильтр «есть файлы»: точный не глушит опечатку.
    mockRows([row(1, 'Гринёв Андрей', 0)], [row(2, 'Гринев Олег', 0)]);
    const res = await call({ search: 'гринев', files: 'partial' });
    expect(res.body.data).toEqual([]);
    expect(h.query).toHaveBeenCalledTimes(2);
  });

  it('СНИЛС — прежним точным сравнением хеша; для цифр вариантов с ошибкой нет', async () => {
    mockRows([row(3, 'Иванов Иван')], [row(4, 'Иванав Олег')]);
    const res = await call({ search: '123-456-789 01' });
    expect(ids(res)).toEqual([3]);
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('p.snils_hash = $');
    expect(params).toContain('hash:snils:12345678901');
    expect(h.query).toHaveBeenCalledTimes(1);
  });
});
