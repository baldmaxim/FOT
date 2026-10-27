import { describe, expect, it } from 'vitest';

import type { IEmployeePayout1c, IPayoutPreview, IPayoutPreviewLine } from '../services/payroll1cPayoutsService';
import {
  initialPayoutChoice,
  payoutChoicesPayload,
  payoutPreviewTotals,
  payoutRelinked,
  payoutsByMonth,
  payoutsTotal,
  singleCandidateLines,
  type PayoutChoice,
} from './payroll1cPayouts';

const payout = (month: string, amount: string, id: number): IEmployeePayout1c => ({
  month, document_id: id, doc_number: `0000-00${id}`, zup2_number: null, doc_date: '2026-10-09', payment_method: 'Зарплата', amount,
});

const candidate = (id: number) => ({
  employee_id: id, full_name: `Сотрудник ${id}`, department: null, worked_in_month: true, by_id_all: false, brigade_match: false,
});

const line = (fingerprint: string, over: Partial<IPayoutPreviewLine> = {}): IPayoutPreviewLine => ({
  fingerprint, line_no: 1, full_name: 'Иванов И.И.', brigade: null, amount: '100.10',
  auto_employee_id: null, current_employee_id: null, current_resolution: null, candidates: [], ...over,
});

const preview = (lines: IPayoutPreviewLine[]): IPayoutPreview => ({
  format: 'external',
  document: {
    doc_guid: 'g', doc_number: '0000-1', zup2_number: null, doc_date: '2026-10-09', period_month: '2026-09-01',
    payment_method: 'Зарплата', salary_project: null, total_amount: '0',
  },
  status: 'new', expected_revision: 0, incoming_content_hash: 'h', changes: null, enrich_fields: [], lines,
});

describe('«Перечислено (1С)»: суммы по месяцам', () => {
  it('несколько ведомостей за месяц — сумма в копейках, документы по порядку', () => {
    const byMonth = payoutsByMonth([payout('2026-08', '0.10', 1), payout('2026-08', '0.20', 2), payout('2026-09', '43500.00', 3)]);
    expect(byMonth.get('2026-08')?.total).toBe(0.3);
    expect(byMonth.get('2026-08')?.documents.map(doc => doc.document_id)).toEqual([1, 2]);
    expect(payoutsTotal(byMonth, ['2026-08', '2026-09'])).toBe(43500.3);
    expect(payoutsTotal(byMonth, ['2026-07'])).toBeNull();
  });
});

describe('окно загрузки: выбор сотрудников', () => {
  const lines = [
    line('a', { auto_employee_id: 5, candidates: [candidate(5)] }),
    line('b', { candidates: [candidate(7)] }),
    line('c', { candidates: [candidate(8), candidate(9)] }),
    line('d', { current_employee_id: null, current_resolution: 'unmatched', candidates: [candidate(10)] }),
  ];
  const doc = preview(lines);

  it('начальный выбор: сохранённое (в том числе «Без сотрудника»), иначе авто по коду, иначе не выбран', () => {
    expect(lines.map(initialPayoutChoice)).toEqual([5, undefined, undefined, null]);
  });

  it('«Подтвердить совпадения по ФИО» — только невыбранные с одним кандидатом', () => {
    const choices = new Map<string, PayoutChoice>(lines.map(l => [l.fingerprint, initialPayoutChoice(l)]));
    expect(singleCandidateLines(doc, choices).map(l => l.fingerprint)).toEqual(['b']);
  });

  it('серверу — только отличия от того, что он возьмёт сам; итоги окна', () => {
    const choices = new Map<string, PayoutChoice>([['a', 5], ['b', 7], ['c', undefined], ['d', 10]]);
    expect(payoutChoicesPayload(doc, choices)).toEqual({ b: 7, d: 10 });
    expect(payoutPreviewTotals(doc, choices)).toEqual({ matched: 300.3, unmatched: 0, pending: 100.1, pendingLines: 1 });
    expect(payoutRelinked(doc, choices)).toBe(true);
    expect(payoutRelinked(doc, new Map([['d', null]]))).toBe(false);
  });
});
