import { describe, expect, it } from 'vitest';

import type { IPayrollCalcResult } from './payroll-calc.rules.js';
import type { IEmployeePayout1c } from './payroll-1c-payouts.service.js';
import type { IPayrollPaidAmount } from './payroll-paid.service.js';
import {
  buildPayslipFrom1c,
  buildPayslipFromFot,
  groupPayouts,
  isFotCalcComplete,
  type IEmployeePayslipHeader,
} from './employee-payslip.rules.js';

const header = (patch: Partial<IEmployeePayslipHeader> = {}): IEmployeePayslipHeader => ({
  month: '2026-09',
  full_name: 'Есенов Максим Николаевич',
  position_name: 'Разработчик',
  period: { from: '2026-09-01', to: '2026-09-30' },
  worked_days: { workday: 22, dayoff: 0 },
  ...patch,
});

const paid = (item: IPayrollPaidAmount['item'], amount: string, month = '2026-09'): IPayrollPaidAmount => ({
  month, item, amount,
});

const payout = (patch: Partial<IEmployeePayout1c>): IEmployeePayout1c => ({
  month: '2026-09',
  document_id: 1,
  doc_number: '0000-002526',
  zup2_number: null,
  doc_date: '2026-10-05',
  payment_method: 'Аванс',
  amount: '0.00',
  ...patch,
});

/** Есенов, сентябрь 2026 — как на проде: оклад, проезд, аванс 05.10 и зарплата 16.10. */
const yesenovPayouts = [
  payout({ document_id: 10, doc_number: '0000-002526', doc_date: '2026-10-05', payment_method: 'Аванс', amount: '54999.50' }),
  payout({
    document_id: 11, doc_number: '0000-002721', doc_date: '2026-10-16', payment_method: 'Зарплата за месяц', amount: '55000.50',
  }),
];

const calcResult = (patch: Partial<IPayrollCalcResult> = {}): IPayrollCalcResult => ({
  lines: [],
  deductions: [],
  accrued: '0.00',
  deducted: '0.00',
  net: '0.00',
  missing: [],
  ...patch,
});

describe('buildPayslipFrom1c', () => {
  it('Есенов, сентябрь: начислено 182 730, выплачено 110 000, сальдо 72 730', () => {
    const slip = buildPayslipFrom1c(header(), [paid('travel', '2730.00'), paid('contract', '180000.00')], yesenovPayouts);
    expect(slip.accruals.map(line => [line.code, line.amount])).toEqual([
      ['contract', '180000.00'],
      ['travel', '2730.00'],
    ]);
    expect(slip.accrued_total).toBe('182730.00');
    expect(slip.deducted_total).toBe('0.00');
    expect(slip.paid_total).toBe('110000.00');
    expect(slip.balance).toBe('72730.00');
    expect(slip.salary_parts).toEqual([]);
  });

  it('без ведомостей — ни «Выплачено», ни сальдо', () => {
    const slip = buildPayslipFrom1c(header({ month: '2026-08' }), [paid('contract', '167142.89', '2026-08')], []);
    expect(slip.payouts).toEqual([]);
    expect(slip.paid_total).toBeNull();
    expect(slip.balance).toBeNull();
  });

  it('удержания отдельно от начислений, нулевые статьи не показываются, копейки без float', () => {
    const slip = buildPayslipFrom1c(header(), [
      paid('contract', '0.10'),
      paid('travel', '0.20'),
      paid('bonus', '0.00'),
      paid('meals', '0.30'),
    ], [payout({ amount: '0.01' })]);
    expect(slip.accruals.map(line => line.code)).toEqual(['contract', 'travel']);
    expect(slip.deductions.map(line => [line.code, line.amount])).toEqual([['meals', '0.30']]);
    expect(slip.accrued_total).toBe('0.30');
    expect(slip.balance).toBe('-0.01');
  });

  it('строки чужого месяца не попадают', () => {
    const slip = buildPayslipFrom1c(header(), [paid('contract', '180000.00'), paid('contract', '1.00', '2026-08')], []);
    expect(slip.accrued_total).toBe('180000.00');
  });

  it('нет дней по табелю — worked_days null', () => {
    const slip = buildPayslipFrom1c(header({ worked_days: null, period: null }), [paid('vacation', '58967.36')], []);
    expect(slip.worked_days).toBeNull();
    expect(slip.period_from).toBeNull();
    expect(slip.accruals).toHaveLength(1);
  });
});

describe('groupPayouts', () => {
  it('несколько строк одной ведомости — одна строка с суммой в копейках', () => {
    const rows = [
      payout({ document_id: 5, amount: '100.10' }),
      payout({ document_id: 5, amount: '200.20' }),
    ];
    expect(groupPayouts(rows)).toEqual([expect.objectContaining({ document_id: 5, amount: '300.30' })]);
  });

  it('две ведомости одного вида в один день — две строки по документам, по номеру', () => {
    const rows = [
      payout({ document_id: 8, doc_number: '0000-000200', amount: '10.00' }),
      payout({ document_id: 7, doc_number: '0000-000100', amount: '20.00' }),
    ];
    expect(groupPayouts(rows).map(item => [item.document_id, item.amount])).toEqual([[7, '20.00'], [8, '10.00']]);
  });

  it('по дате ведомости', () => {
    const rows = [
      payout({ document_id: 2, doc_date: '2026-10-16' }),
      payout({ document_id: 1, doc_date: '2026-10-05' }),
    ];
    expect(groupPayouts(rows).map(item => item.document_id)).toEqual([1, 2]);
  });
});

describe('buildPayslipFromFot', () => {
  const fotCalc = calcResult({
    lines: [
      {
        code: 'contract',
        amount: '180000.00',
        parts: [
          {
            kind: 'salary', from: '2026-10-01', to: '2026-10-15', salary: '150000.00', bonus: '0.00',
            days: 11, norm: 22, rounding: 'daily_kopeck', amount: '75000.00',
          },
          {
            kind: 'salary', from: '2026-10-16', to: '2026-10-31', salary: '210000.00', bonus: '0.00',
            days: 11, norm: 22, rounding: 'daily_kopeck', amount: '105000.00',
          },
        ],
      },
      { code: 'brigade', amount: '1000.00' },
      { code: 'overtime', amount: '0.00' },
      { code: 'travel', amount: '2730.00' },
    ],
    deductions: [{ kind_id: 3, kind: 'Спецодежда', amount: '500.00' }],
    accrued: '183730.00',
    deducted: '500.00',
    net: '183230.00',
  });

  it('строки расчёта и удержания видов «Справочника»; нулевые не показываются', () => {
    const slip = buildPayslipFromFot(header({ month: '2026-10' }), fotCalc, []);
    expect(slip.accruals.map(line => [line.code, line.name, line.amount])).toEqual([
      ['contract', null, '180000.00'],
      ['brigade', null, '1000.00'],
      ['travel', null, '2730.00'],
    ]);
    expect(slip.deductions).toEqual([
      { key: 'deduction-kind-3', code: null, name: 'Спецодежда', amount: '500.00' },
    ]);
    expect(slip.accrued_total).toBe('183730.00');
    expect(slip.deducted_total).toBe('500.00');
    expect(slip.balance).toBeNull();
  });

  it('две части оклада — со своими периодами и днями', () => {
    const slip = buildPayslipFromFot(header({ month: '2026-10' }), fotCalc, []);
    expect(slip.salary_parts).toEqual([
      { calc_type: 'salary', from: '2026-10-01', to: '2026-10-15', amount: '150000.00', days: 11 },
      { calc_type: 'salary', from: '2026-10-16', to: '2026-10-31', amount: '210000.00', days: 11 },
    ]);
  });

  it('ведомости есть — сальдо по строкам листка', () => {
    const slip = buildPayslipFromFot(header({ month: '2026-10' }), fotCalc, [payout({ amount: '83230.00' })]);
    expect(slip.balance).toBe('100000.00');
  });
});

describe('isFotCalcComplete', () => {
  it('полный расчёт', () => {
    expect(isFotCalcComplete(calcResult({ lines: [{ code: 'contract', amount: '1.00' }], net: '1.00' }))).toBe(true);
  });

  it('итог неизвестен — не готов', () => {
    expect(isFotCalcComplete(calcResult({ net: null, missing: ['no_terms'] }))).toBe(false);
  });

  it('нет отпускных или больничных — не готов', () => {
    expect(isFotCalcComplete(calcResult({ missing: ['vacation_pay'] }))).toBe(false);
    expect(isFotCalcComplete(calcResult({ missing: ['sick_pay'] }))).toBe(false);
    expect(isFotCalcComplete(calcResult({ missing: ['educational_pay'] }))).toBe(false);
  });

  it('строка без суммы — не готов', () => {
    expect(isFotCalcComplete(calcResult({ lines: [{ code: 'brigade', amount: null }] }))).toBe(false);
  });

  it('«нет дней» — справочно, листок готов', () => {
    expect(isFotCalcComplete(calcResult({ missing: ['no_days'] }))).toBe(true);
  });
});
