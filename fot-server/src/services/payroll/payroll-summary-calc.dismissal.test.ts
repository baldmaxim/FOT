import { describe, expect, it, vi } from 'vitest';

/**
 * «Свод» и увольнение из 1С (API, миграция 372): компенсация и пособие учитываются по одному разу — строка расчёта ФОТ,
 * ячейка «Оплачено» документа 1С и разовая доплата «Выходное пособие при увольнении» не складываются.
 */

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../config/postgres.js', () => ({ query }));

import { loadSummaryExtras } from './payroll-summary-calc.service.js';
import { mergeSummaryMonth } from './payroll-summary-calc.rules.js';
import type { PayrollCalcWithPreliminary } from './payroll-calc.service.js';

const calc = (lines: Array<{ code: string; amount: string }>): PayrollCalcWithPreliminary => ({
  state: 'counted',
  lines: lines.map(line => ({ ...line, parts: [] })),
  missing: [],
  deductions: [],
}) as unknown as PayrollCalcWithPreliminary;

const mockDb = (activeDismissal: boolean) => {
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM payroll_one_time_supplements')) {
      return [
        { employee_id: 1544, month: '2026-11', reason: 'Выходное пособие при увольнении', amount: '330000.00' },
        { employee_id: 1544, month: '2026-11', reason: 'Премия', amount: '1000.00' },
      ];
    }
    if (sql.includes('FROM payroll_1c_dismissal_documents')) return activeDismissal ? [{ employee_id: 1544, month: '2026-11' }] : [];
    return [];
  });
};

describe('«Свод» и увольнение из 1С', () => {
  it('действующий документ: пособие и компенсация — по одному разу, разовое пособие не добавляется', async () => {
    mockDb(true);
    const extras = await loadSummaryExtras(['2026-11'], [1544]);
    const oneTime = extras.oneTime.get('1544|2026-11') ?? [];
    expect(oneTime.map(item => item.reason)).toEqual(['Премия']);

    const month = mergeSummaryMonth({
      paid: new Map([['severance', '330000.00'], ['vacation_compensation', '35602.21']]),
      calc: calc([
        { code: 'contract', amount: '50000.00' },
        { code: 'severance', amount: '330000.00' },
        { code: 'vacation_compensation', amount: '35602.21' },
      ]),
      oneTime,
      deductions: [],
    });
    expect(month.cents.get('severance')).toBe(33000000);
    expect(month.cents.get('vacation_compensation')).toBe(3560221);
    expect(month.cents.get('premium')).toBe(100000);
  });

  it('пособие 0,00 в действующем документе — разовое пособие в «Своде» не появляется (как в «Сумме»)', async () => {
    mockDb(true);
    const extras = await loadSummaryExtras(['2026-11'], [1544]);
    const month = mergeSummaryMonth({
      paid: new Map(), calc: calc([{ code: 'contract', amount: '50000.00' }]),
      oneTime: extras.oneTime.get('1544|2026-11') ?? [], deductions: [],
    });
    expect(month.cents.has('severance')).toBe(false);
  });

  it('документа нет — разовое пособие как раньше, статьёй «Выходное пособие при увольнении»', async () => {
    mockDb(false);
    const extras = await loadSummaryExtras(['2026-11'], [1544]);
    const month = mergeSummaryMonth({
      paid: new Map(), calc: calc([{ code: 'contract', amount: '50000.00' }]),
      oneTime: extras.oneTime.get('1544|2026-11') ?? [], deductions: [],
    });
    expect(month.cents.get('severance')).toBe(33000000);
  });
});
