import { describe, expect, it } from 'vitest';

import type { IEmployeePayslipPayout } from '../services/employeePayslipService';
import {
  accruedTitle,
  formatPayslipAmount,
  formatPayslipRate,
  formatVacationDays,
  payoutLabel,
  payslipLineLabel,
} from './employeePayslip';

const payout = (patch: Partial<IEmployeePayslipPayout>): IEmployeePayslipPayout => ({
  document_id: 1, doc_number: '0000-002526', doc_date: '2026-10-05', payment_method: 'Аванс', amount: '0.00', ...patch,
});

describe('расчётный лист в ЛК: подписи и формат', () => {
  it('подписи статей — как в карточке «Зарплаты»; доля бригады и вид удержания — свои', () => {
    expect(payslipLineLabel({ code: 'contract', name: null })).toBe('По трудовому договору');
    expect(payslipLineLabel({ code: 'travel', name: null })).toBe('Проезд');
    expect(payslipLineLabel({ code: 'brigade', name: null })).toBe('Выработка бригады');
    expect(payslipLineLabel({ code: null, name: 'Спецодежда' })).toBe('Спецодежда');
  });

  it('«Начислено за N дней» со склонением; без дней — просто «Начислено»', () => {
    expect(accruedTitle({ workday: 21, dayoff: 0 })).toBe('Начислено за 21 день');
    expect(accruedTitle({ workday: 17, dayoff: 3 })).toBe('Начислено за 20 дней');
    expect(accruedTitle({ workday: 22, dayoff: 0 })).toBe('Начислено за 22 дня');
    expect(accruedTitle(null)).toBe('Начислено');
  });

  it('суммы с копейками, оклад и остаток отпуска — без лишних нулей', () => {
    expect(formatPayslipAmount('182730.00').replace(/\s/g, ' ')).toBe('182 730,00');
    expect(formatPayslipRate('180000.00').replace(/\s/g, ' ')).toBe('180 000');
    expect(formatPayslipRate('730.5000')).toBe('730,5');
    expect(formatVacationDays('16.31')).toBe('16,31');
    expect(formatVacationDays('16.00')).toBe('16');
  });

  it('ведомость: «Аванс от 05.10.26»; две одного вида в один день — с номером', () => {
    const single = payout({});
    expect(payoutLabel(single, [single])).toBe('Аванс от 05.10.26');
    const twin = payout({ document_id: 2, doc_number: '0000-002600' });
    expect(payoutLabel(twin, [single, twin])).toBe('Аванс от 05.10.26, № 0000-002600');
  });
});
