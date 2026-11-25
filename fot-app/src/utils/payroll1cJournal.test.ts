import { describe, expect, it } from 'vitest';

import type { IEmployeePayout1c, IPayoutJournalListDoc } from '../services/payroll1cPayoutsService';
import {
  employeePayoutMonths,
  PAYOUT_JOURNAL_COLUMNS,
  payoutJournalSearchText,
  payoutJournalTotals,
  payoutMonthsRange,
} from './payroll1cJournal';

const payout = (month: string, id: number, amount: string): IEmployeePayout1c => ({
  month, document_id: id, doc_number: `0000-00${id}`, zup2_number: null, doc_date: '2026-11-20', payment_method: 'Аванс', amount,
  organization_inn: '7736255508', origin: 'api', comment: null, basis: null,
});

const doc = (over: Partial<IPayoutJournalListDoc>): IPayoutJournalListDoc => ({
  id: 1, doc_number: '0000-005001', zup2_number: null, doc_date: '2026-11-20', period_month: '2026-11',
  organization_inn: '7736255508', payment_method: 'Премии', total_amount: '100.10', lines_amount: '100.10', lines: 2,
  employees: 1, unmatched_lines: 1, unmatched_amount: '0.10', comment: null, origin: 'api', state: 'active', version: '1',
  updated_at: '2026-11-20', names: 'Иванов Иван · Иванов Иван Иванович', ...over,
});

describe('payroll1cJournal', () => {
  it('окно сотрудника: только выбранные месяцы, по возрастанию, итог в копейках = ячейке', () => {
    const rows = [payout('2026-11', 1, '0.10'), payout('2026-09', 2, '0.20'), payout('2026-10', 3, '5.00'), payout('2026-11', 4, '0.20')];
    const result = employeePayoutMonths(rows, ['2026-11', '2026-09']);
    expect(result.months.map(entry => [entry.month, entry.documents.map(row => row.document_id), entry.totalCents]))
      .toEqual([['2026-09', [2], 20], ['2026-11', [1, 4], 30]]);
    expect(result.totalCents).toBe(50);
    expect(employeePayoutMonths(rows, 'all').totalCents).toBe(550);
  });

  it('период запроса — от первого до последнего выбранного месяца, «весь период» — без границ', () => {
    expect(payoutMonthsRange(['2026-11', '2026-09'])).toEqual({ from: '2026-09', to: '2026-11' });
    expect(payoutMonthsRange('all')).toEqual({ from: '2000-01', to: '2099-12' });
  });

  it('журнал: «Итого» без отменённых, поиск — номер и ФИО строк, «Без сотрудника» — «—» при нуле', () => {
    const totals = payoutJournalTotals([doc({}), doc({ id: 2, total_amount: '0.20', unmatched_lines: 0, unmatched_amount: '0' }),
      doc({ id: 3, state: 'cancelled', total_amount: '1000.00', lines: 0, unmatched_lines: 0, unmatched_amount: '0' })]);
    expect(totals?.export).toEqual({ doc_date: 'Итого', total_amount: '100.30', unmatched: '0.10' });
    expect(payoutJournalTotals([doc({ state: 'cancelled' })])).toBeNull();
    expect(payoutJournalSearchText(doc({ zup2_number: '00003123' }))).toBe('0000-005001 · 00003123 · Иванов Иван · Иванов Иван Иванович');
    const unmatched = PAYOUT_JOURNAL_COLUMNS.find(column => column.key === 'unmatched')!;
    expect(unmatched.text(doc({ unmatched_lines: 0, unmatched_amount: '0' }))).toBe('—');
    const state = PAYOUT_JOURNAL_COLUMNS.find(column => column.key === 'state')!;
    expect(state.text(doc({ state: 'cancelled' }))).toBe('Отменена в 1С');
  });
});
