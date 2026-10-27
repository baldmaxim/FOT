import { describe, expect, it } from 'vitest';

import type { TimesheetEmployee } from '../types';
import type { ITimesheetSalaryResponse } from '../types/timesheet';
import {
  findSalaryRow, formatKtu, formatSalaryAmount, getRemoteScheduleHours, salaryAmountTitle, salaryLineTitle,
} from './timesheetSalary';

const employee = (id: number, source?: TimesheetEmployee['source']): TimesheetEmployee => ({
  id, full_name: 'Халимзода Раджабали Абдурахмон', position_id: null, position_name: null,
  org_department_id: 'b', employment_status: 'active', source,
});

const data: ITimesheetSalaryResponse = {
  department_id: 'b', month: '2026-10', kind: 'brigade', state: 'preliminary', distribution: 'ok',
  as_of: '2026-10-26', open_ranges: [], output_amount: '1000000.00', errors: [], computed_at: null,
  rows: [{ employee_id: 1951, ktu: '1.5', counted_hours: 210, amount: '273399.53', source: 'live', can_edit: true }],
};

describe('timesheetSalary', () => {
  it('строка — только у состава бригады: у начальника участка суммы нет', () => {
    expect(findSalaryRow(data, employee(1951))?.amount).toBe('273399.53');
    expect(findSalaryRow(data, employee(1951, 'department'))?.ktu).toBe('1.5');
    expect(findSalaryRow(data, employee(1951, 'supervisor'))).toBeNull();
    expect(findSalaryRow(data, employee(777))).toBeNull();
    expect(findSalaryRow(undefined, employee(1951))).toBeNull();
  });

  it('сумма с копейками и пробелом тысяч, без суммы — «—»', () => {
    expect(formatSalaryAmount('273399.53').replace(/\s/g, ' ')).toBe('273 399,53');
    expect(formatSalaryAmount('0.00')).toBe('0,00');
    expect(formatSalaryAmount(null)).toBe('—');
  });

  it('КТУ с запятой', () => {
    expect(formatKtu('1.5')).toBe('1,5');
  });
});

describe('подсказка «Суммы» — к выплате', () => {
  const plain = (value: string | undefined): string | undefined => value?.replace(/\s/g, ' ');

  it('бригада: доля, КТУ, часы и удержания', () => {
    const row = { ...data.rows[0], share: '141818.18', deducted: '3500.00', amount: '138318.18', missing: [] };
    expect(plain(salaryAmountTitle(data, row))).toBe('Доля 141 818,18 · КТУ 1,5 · 210 ч · удержано 3 500,00');
  });

  it('отдел: закрытый табель — «К выплате (ФОТ)» и чего нет; незакрытый — «Табель не закрыт»', () => {
    const department: ITimesheetSalaryResponse = { ...data, kind: 'department', state: null, distribution: null };
    const row = {
      employee_id: 71, ktu: null, counted_hours: null, amount: '252730.00', share: null, deducted: '0.00',
      missing: ['vacation_pay' as const], payout_state: 'closed' as const, source: null, can_edit: false,
    };
    expect(salaryAmountTitle(department, row)).toBe('К выплате (ФОТ) · без: отпускные');
    expect(salaryAmountTitle(department, { ...row, amount: null, payout_state: 'not_closed' })).toBe('Табель не закрыт');
  });
});

describe('«Оклад» и «Переработка» отдела', () => {
  const row = {
    employee_id: 1428, ktu: null, counted_hours: null, amount: '255570.91', share: null, deducted: '0.00',
    missing: [], payout_state: 'closed' as const, source: null, can_edit: false,
  };
  const contract = { code: 'contract' as const, amount: '250000.00', days: { worked: 22, norm: 22 } };
  const overtime = { code: 'overtime' as const, amount: '2840.91', days: { worked: 0, norm: 22 }, hours: 2 };

  it('строка есть — из скольких дней или часов', () => {
    expect(salaryLineTitle(row, contract)).toBe('22 из 22 дн.');
    expect(salaryLineTitle(row, overtime)).toBe('2 ч');
  });

  it('табель не закрыт — «Табель не закрыт»; закрыт без строки — без подсказки', () => {
    expect(salaryLineTitle({ ...row, payout_state: 'not_closed' }, null)).toBe('Табель не закрыт');
    expect(salaryLineTitle(row, null)).toBeUndefined();
    expect(salaryLineTitle(row, undefined)).toBeUndefined();
  });
});

describe('часы «УУ» по графику', () => {
  it('удалёнка — норма дня целыми', () => {
    expect(getRemoteScheduleHours('remote', 8)).toBe(8);
    expect(getRemoteScheduleHours('remote', 7.5)).toBe(8);
    expect(getRemoteScheduleHours('remote', 7)).toBe(7);
  });

  it('нет нормы (выходной по графику) или не удалёнка — нет часов', () => {
    expect(getRemoteScheduleHours('remote', 0)).toBeNull();
    expect(getRemoteScheduleHours('work', 8)).toBeNull();
    expect(getRemoteScheduleHours('sick_worked', 8)).toBeNull();
    expect(getRemoteScheduleHours(undefined, 8)).toBeNull();
  });
});
