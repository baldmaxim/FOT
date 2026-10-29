import { describe, expect, it } from 'vitest';

import type { TimesheetEmployee, TimesheetStatus } from '../types';
import type { ITimesheetSalaryResponse } from '../types/timesheet';
import {
  findSalaryRow, formatKtu, formatSalaryAmount, getSalaryLetterHours, isSalaryRowMuted, salaryAmountTitle, salaryLineTitle,
  salaryOvertimeNote, salaryPreliminaryTitle,
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

  it('отдел, предварительно — «Табель не закрыт, предварительно», удержания и чего нет', () => {
    const department: ITimesheetSalaryResponse = {
      ...data, month: '2026-09', kind: 'department', state: null, distribution: null, as_of: '2026-09-30',
    };
    const row = {
      employee_id: 71, ktu: null, counted_hours: null, amount: '251500.00', share: null, deducted: '1200.00',
      missing: ['vacation_pay' as const], payout_state: 'preliminary' as const, source: null, can_edit: false,
    };
    expect(plain(salaryAmountTitle(department, row)))
      .toBe('Табель не закрыт, предварительно · удержано 1 200,00 · без: отпускные');
  });
});

describe('предварительный расчёт отдела', () => {
  const department: ITimesheetSalaryResponse = {
    ...data, month: '2026-10', kind: 'department', state: null, distribution: null, as_of: '2026-10-27',
  };
  const row = {
    employee_id: 71, ktu: null, counted_hours: null, amount: '251500.00', share: null, deducted: '0.00',
    missing: [], payout_state: 'preliminary' as const, source: null, can_edit: false,
  };

  it('подсказка с заглавной: прошлый месяц — без даты, текущий — «по 27.10», as_of нет — без даты', () => {
    expect(salaryPreliminaryTitle({ ...department, month: '2026-09', as_of: '2026-09-30' }))
      .toBe('Табель не закрыт, предварительно');
    expect(salaryPreliminaryTitle(department)).toBe('Табель не закрыт, предварительно по 27.10');
    expect(salaryPreliminaryTitle({ ...department, as_of: null })).toBe('Табель не закрыт, предварительно');
  });

  it('приглушение: отдел — только предварительные; бригада — только «Требует перерасчёта»', () => {
    expect(isSalaryRowMuted(department, row)).toBe(true);
    expect(isSalaryRowMuted(department, { ...row, payout_state: 'closed' })).toBe(false);
    expect(isSalaryRowMuted(department, { ...row, payout_state: 'not_closed' })).toBe(false);
    expect(isSalaryRowMuted(data, data.rows[0])).toBe(false);
    expect(isSalaryRowMuted({ ...data, state: 'stale' }, data.rows[0])).toBe(true);
    expect(isSalaryRowMuted(undefined, row)).toBe(false);
    expect(isSalaryRowMuted(department, null)).toBe(false);
  });
});

describe('«Оклад» и «Переработка» отдела', () => {
  const department: ITimesheetSalaryResponse = {
    ...data, month: '2026-10', kind: 'department', state: null, distribution: null, as_of: null,
  };
  const row = {
    employee_id: 1428, ktu: null, counted_hours: null, amount: '255570.91', share: null, deducted: '0.00',
    missing: [], payout_state: 'closed' as const, source: null, can_edit: false,
  };
  const contract = { code: 'contract' as const, amount: '250000.00', days: { worked: 22, norm: 22 } };
  const overtime = { code: 'overtime' as const, amount: '2840.91', days: { worked: 0, norm: 22 }, hours: 2 };

  it('строка есть — из скольких дней или часов', () => {
    expect(salaryLineTitle(department, row, contract)).toBe('22 из 22 дн.');
    expect(salaryLineTitle(department, row, overtime)).toBe('2 ч');
  });

  it('предварительно — «Табель не закрыт, предварительно» и дни строки', () => {
    const prelim = { ...department, as_of: '2026-10-27' };
    const prelimRow = { ...row, payout_state: 'preliminary' as const };
    expect(salaryLineTitle(prelim, prelimRow, contract)).toBe('Табель не закрыт, предварительно по 27.10 · 22 из 22 дн.');
    expect(salaryLineTitle(prelim, prelimRow, null)).toBe('Табель не закрыт, предварительно по 27.10');
  });

  it('табель не закрыт — «Табель не закрыт»; закрыт без строки — без подсказки', () => {
    expect(salaryLineTitle(department, { ...row, payout_state: 'not_closed' }, null)).toBe('Табель не закрыт');
    expect(salaryLineTitle(department, row, null)).toBeUndefined();
    expect(salaryLineTitle(department, row, undefined)).toBeUndefined();
  });

  it('подпись под «Переработкой» — часы будней и выходы; у «Оклада» и без строки — нет', () => {
    expect(salaryOvertimeNote(overtime)).toBe('2 ч');
    expect(salaryOvertimeNote({ ...overtime, days: { worked: 1, norm: 22 } })).toBe('1 вых. · 2 ч');
    expect(salaryOvertimeNote({ ...overtime, days: { worked: 1, norm: 22 }, hours: undefined })).toBe('1 вых.');
    expect(salaryOvertimeNote({ ...overtime, hours: 1.5 })).toBe('1,5 ч');
    expect(salaryOvertimeNote(contract)).toBeNull();
    expect(salaryOvertimeNote(null)).toBeNull();
    expect(salaryOvertimeNote(undefined)).toBeNull();
  });
});

describe('часы под «УУ» / «РБ» / «УД»', () => {
  const entry = (status: TimesheetStatus, hours: number | null = 8, overridden?: boolean) => ({
    status, hours_worked: hours, hours_overridden: overridden,
  });

  it('«УУ» с правкой часов — часы правки целыми (Разаханов, 10.09: 9 ч)', () => {
    expect(getSalaryLetterHours(entry('remote', 9, true), 8)).toEqual({ label: 'УУ', hours: 9, source: 'override' });
    expect(getSalaryLetterHours(entry('remote', 8.83, true), 8)).toEqual({ label: 'УУ', hours: 9, source: 'override' });
  });

  it('«УУ» без правки или с нулём часов — норма дня по графику', () => {
    expect(getSalaryLetterHours(entry('remote', 9), 8)).toEqual({ label: 'УУ', hours: 8, source: 'schedule' });
    expect(getSalaryLetterHours(entry('remote', 0, true), 7.5)).toEqual({ label: 'УУ', hours: 8, source: 'schedule' });
    expect(getSalaryLetterHours(entry('remote', null), 7)).toEqual({ label: 'УУ', hours: 7, source: 'schedule' });
  });

  it('«РБ» и «УД» — норма дня по графику', () => {
    expect(getSalaryLetterHours(entry('sick_worked', 10), 10)).toEqual({ label: 'РБ', hours: 10, source: 'schedule' });
    expect(getSalaryLetterHours(entry('study_day', 8, true), 7)).toEqual({ label: 'УД', hours: 7, source: 'schedule' });
  });

  it('нет нормы (выходной по графику) или другой статус — нет часов', () => {
    expect(getSalaryLetterHours(entry('remote', 0), 0)).toBeNull();
    expect(getSalaryLetterHours(entry('sick_worked', 0), 0)).toBeNull();
    expect(getSalaryLetterHours(entry('work', 9, true), 8)).toBeNull();
    expect(getSalaryLetterHours(entry('manual', 9, true), 8)).toBeNull();
    expect(getSalaryLetterHours(null, 8)).toBeNull();
  });
});
