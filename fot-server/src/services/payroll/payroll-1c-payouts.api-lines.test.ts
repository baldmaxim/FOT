import { beforeEach, describe, expect, it, vi } from 'vitest';

// Сотрудник строки ведомости из API: ID_FOT главнее (нет в ФОТ, подрядчик месяца — без сотрудника, расхождение с кодом
// физлица — предупреждение); без ID_FOT — код физлица, затем ФИО (как генераторы).

const { matchPayoutLines, loadPayoutEligibility, query } = vi.hoisted(() => ({
  matchPayoutLines: vi.fn(),
  loadPayoutEligibility: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../config/postgres.js', () => ({ query }));
vi.mock('./payroll-1c-payouts.matching.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./payroll-1c-payouts.matching.js')>()),
  matchPayoutLines,
  loadPayoutEligibility,
}));

import { resolvePayoutApiLines } from './payroll-1c-payouts.api-lines.js';
import type { IPayoutApiDocument } from './payroll-1c-payouts.month-xml.js';

const line = (key: string, fullName: string, idFot: number | null) => ({
  lineNo: 1, lineKey: key, fullName, personIdAll: null, brigade: null, amountCents: 100, idFot, basis: null,
});
const candidate = (id: number, worked = true) => ({ employee_id: id, full_name: 'x', department: null, worked_in_month: worked, by_id_all: false, brigade_match: false });

describe('resolvePayoutApiLines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue([]);
    loadPayoutEligibility.mockResolvedValue(new Map([
      [10, { eligible: true }],
      [11, { eligible: false }],
    ]));
    matchPayoutLines.mockResolvedValue(new Map([
      ['a', { auto_employee_id: null, candidates: [] }],
      ['b', { auto_employee_id: null, candidates: [] }],
      ['c', { auto_employee_id: null, candidates: [] }],
      ['d', { auto_employee_id: 20, candidates: [candidate(20)] }],
      ['e', { auto_employee_id: null, candidates: [candidate(30)] }],
      ['f', { auto_employee_id: null, candidates: [candidate(40), candidate(41)] }],
      ['g', { auto_employee_id: 20, candidates: [] }],
    ]));
  });

  it('ID_FOT, код физлица, ФИО, тёзки, без сотрудника, расхождение ID_FOT и кода физлица', async () => {
    const doc = {
      periodMonth: '2026-11-01',
      lines: [
        line('a', 'Иванов', 10), line('b', 'Петров', 99), line('c', 'Подрядчик', 11), line('d', 'Сидоров', null),
        line('e', 'Козлов', null), line('f', 'Тёзка', null), line('g', 'Смирнов', 10),
      ],
    } as unknown as IPayoutApiDocument;
    const result = await resolvePayoutApiLines(doc);
    expect(result.map(item => [item.lineKey, item.employeeId, item.resolution])).toEqual([
      ['a', 10, 'auto_id_fot'],
      ['b', null, 'unmatched'],
      ['c', null, 'unmatched'],
      ['d', 20, 'auto_id_all'],
      ['e', 30, 'confirmed'],
      ['f', null, 'unmatched'],
      ['g', 10, 'auto_id_fot'],
    ]);
    expect(result[1].reason).toBe('API 1С: ID_FOT 99 — нет в ФОТ');
    expect(result[2].reason).toBe('API 1С: ID_FOT 11 — в месяце у подрядчика');
    expect(result[4].reason).toBe('API 1С: один кандидат по ФИО');
    expect(result[5].reason).toBe('API 1С: тёзки — без сотрудника');
    expect(result[6].warning).toBe('Смирнов: код физлица 1С ведёт к сотруднику 20, ID_FOT — 10; взят ID_FOT');
    expect(loadPayoutEligibility).toHaveBeenCalledWith([10, 99, 11], '2026-11-01');
  });
});
