import { describe, expect, it } from 'vitest';

import type { IPayrollPaidDebt } from '../services/payrollPaidDebtsService';
import { paidDebtMonth, PAYROLL_PAID_DEBT_KINDS } from './payrollPaidDebts';

const row = (month: string, line: IPayrollPaidDebt['line'], amount: string): IPayrollPaidDebt => ({ month, line, amount });

describe('долги прошлых месяцев (справочно)', () => {
  it('погашен полностью: «Погашено» = долгу (Зиякулов, июнь)', () => {
    expect(paidDebtMonth([row('2026-06', 'debt_day_salary', '4141.90')], '2026-06')).toEqual({
      kinds: [{ code: 'debt_day_salary', label: 'Оклад по дням', amount: 4141.9 }],
      writtenOff: null,
      carriedForward: null,
      repaid: 4141.9,
    });
  });

  it('частично: «Погашено» = долг − перенесено; виды — в порядке ведомости, в копейках', () => {
    const month = paidDebtMonth([
      row('2026-06', 'debt_tmc', '9000.00'),
      row('2026-06', 'debt_day_salary', '22559.69'),
      row('2026-06', 'carried_forward', '9000.00'),
      row('2026-07', 'debt_tmc', '9000.00'),
    ], '2026-06');
    expect(month?.kinds.map(kind => kind.label)).toEqual(['Оклад по дням', 'ТМЦ']);
    expect(month?.repaid).toBe(22559.69);
    expect(month?.carriedForward).toBe(9000);
  });

  it('закрыто документом 1С и перенесено больше долга — «Погашено» не уходит в минус', () => {
    expect(paidDebtMonth([
      row('2026-06', 'debt_day_salary', '18000.00'),
      row('2026-06', 'written_off', '16000.00'),
      row('2026-06', 'carried_forward', '2000.00'),
    ], '2026-06')?.repaid).toBe(0);
    // Новый долг месяца: прошлого нет, перенесено на следующий — «Погашено» не 0, а «—».
    expect(paidDebtMonth([row('2026-07', 'written_off', '2000.00'), row('2026-07', 'carried_forward', '18000.00')], '2026-07'))
      .toEqual({ kinds: [], writtenOff: 2000, carriedForward: 18000, repaid: null });
  });

  it('копейки без ошибки float: 0,1 + 0,2', () => {
    expect(paidDebtMonth([row('2026-05', 'debt_correction', '0.10'), row('2026-05', 'debt_meals', '0.20')], '2026-05')?.repaid).toBe(0.3);
  });

  it('строк за месяц нет — null', () => {
    expect(paidDebtMonth([row('2026-05', 'debt_tmc', '1.00')], '2026-06')).toBeNull();
    expect(paidDebtMonth([], '2026-06')).toBeNull();
  });

  it('виды без повторов, подписи уникальны', () => {
    expect(new Set(PAYROLL_PAID_DEBT_KINDS.map(kind => kind.code)).size).toBe(PAYROLL_PAID_DEBT_KINDS.length);
    expect(new Set(PAYROLL_PAID_DEBT_KINDS.map(kind => kind.label)).size).toBe(PAYROLL_PAID_DEBT_KINDS.length);
  });
});
