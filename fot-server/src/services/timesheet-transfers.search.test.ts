import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Переводы и исключения» (админка табеля): поиск по ФИО — одно правило для переводов (JS) и исключений (SQL);
 * опечатка — только если точного нет ни там, ни там.
 */

const { h } = vi.hoisted(() => ({
  h: {
    transferNames: new Map<number, string>(),
    exclusionsExact: [] as Array<{ id: number; full_name: string }>,
    exclusionsFuzzy: [] as Array<{ id: number; full_name: string }>,
    query: vi.fn(),
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('./timesheet-department-assignments.service.js', () => ({ formatDateShift: vi.fn() }));

const { listAllTransfersAndExclusions } = await import('./timesheet-transfers.service.js');

const D_OLD = '00000000-0000-0000-0000-0000000000a1';
const D_NEW = '00000000-0000-0000-0000-0000000000a2';

beforeEach(() => {
  h.transferNames = new Map();
  h.exclusionsExact = [];
  h.exclusionsFuzzy = [];
  h.query.mockReset().mockImplementation(async (sql: string) => {
    const ids = [...h.transferNames.keys()];
    if (sql.includes('FROM employee_assignments') && sql.includes('effective_to IS NULL')) {
      return ids.map(id => ({ id: `n${id}`, employee_id: id, org_department_id: D_NEW, effective_from: '2026-10-01', effective_to: null }));
    }
    if (sql.includes('FROM employee_assignments')) {
      return ids.map(id => ({ id: `o${id}`, employee_id: id, org_department_id: D_OLD, effective_from: '2026-01-01', effective_to: '2026-09-30' }));
    }
    if (sql.includes('excluded_from_timesheet = true')) {
      return (sql.includes('unnest(') ? [...h.exclusionsExact, ...h.exclusionsFuzzy] : h.exclusionsExact)
        .map(row => ({ ...row, position_id: null, org_department_id: null, excluded_from_timesheet_date: '2026-10-05', excluded_from_timesheet_at: null }));
    }
    if (sql.includes('FROM employees')) {
      return ids.map(id => ({ id, full_name: h.transferNames.get(id), position_id: null, is_archived: false, employment_status: 'active' }));
    }
    return [];
  });
});

const names = (listing: Awaited<ReturnType<typeof listAllTransfersAndExclusions>>) => ({
  transfers: listing.transfers.map(row => row.employee_full_name),
  exclusions: listing.exclusions.map(row => row.employee_full_name),
});

describe('listAllTransfersAndExclusions — поиск по ФИО', () => {
  it('ё = е и раскладка в переводах; исключения — тем же правилом в SQL', async () => {
    h.transferNames = new Map([[1, 'Гринёв Андрей'], [2, 'Петров Пётр']]);
    expect(names(await listAllTransfersAndExclusions({ employee_query: 'uhbyt' })).transfers).toEqual(['Гринёв Андрей']);
    const exclusionsSql = String(h.query.mock.calls.find(([sql]) => String(sql).includes('excluded_from_timesheet = true'))?.[0]);
    expect(exclusionsSql).toContain('(full_name ~* $1 OR full_name ~* $2)');
  });

  it('точный перевод есть — исключения с опечаткой не подмешиваются', async () => {
    h.transferNames = new Map([[1, 'Гринёв Андрей']]);
    h.exclusionsFuzzy = [{ id: 5, full_name: 'Гринав Олег' }];
    expect(names(await listAllTransfersAndExclusions({ employee_query: 'гринев' }))).toEqual({
      transfers: ['Гринёв Андрей'], exclusions: [],
    });
  });

  it('точное исключение есть — переводы с опечаткой не подмешиваются', async () => {
    h.transferNames = new Map([[1, 'Гринав Олег']]);
    h.exclusionsExact = [{ id: 5, full_name: 'Гринёв Андрей' }];
    expect(names(await listAllTransfersAndExclusions({ employee_query: 'гринев' }))).toEqual({
      transfers: [], exclusions: ['Гринёв Андрей'],
    });
  });

  it('точного нет нигде — одна ошибка в обоих списках', async () => {
    h.transferNames = new Map([[1, 'Гринёв Андрей'], [2, 'Петров Пётр']]);
    h.exclusionsFuzzy = [{ id: 5, full_name: 'Гринева Ольга' }];
    expect(names(await listAllTransfersAndExclusions({ employee_query: 'грнев' }))).toEqual({
      transfers: ['Гринёв Андрей'], exclusions: ['Гринева Ольга'],
    });
  });
});
