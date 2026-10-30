import { describe, expect, it } from 'vitest';

import type { TimesheetEmployee, TimesheetStatus } from '../types';
import type { ITimesheetSalaryObject, ITimesheetSalaryResponse } from '../types/timesheet';
import {
  describeSalaryState, displayedHours, findSalaryRow, formatDayHours, formatKtu, formatSalaryAmount, getSalaryLetterHours, isOutputClearOnly,
  isSalaryRowMuted, missingObjectsNote, objectShareTitle, salaryAmountTitle, salaryLineTitle, salaryObjectStateNote,
  salaryOvertimeNote, sortSalaryRows, totalDaysOfEmployee,
} from './timesheetSalary';

const NBSP = ' ';

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

  it('отдел: «К выплате (ФОТ)» и чего нет; посчитать нечем — без подсказки', () => {
    const department: ITimesheetSalaryResponse = { ...data, kind: 'department', state: null, distribution: null };
    const row = {
      employee_id: 71, ktu: null, counted_hours: null, amount: '252730.00', share: null, deducted: '0.00',
      missing: ['vacation_pay' as const], payout_state: 'closed' as const, source: null, can_edit: false,
    };
    expect(salaryAmountTitle(department, row)).toBe('К выплате (ФОТ) · без: отпускные');
    expect(salaryAmountTitle(department, { ...row, amount: null, payout_state: 'not_closed' })).toBeUndefined();
  });

  it('отдел, незакрытый табель — так же «К выплате (ФОТ)», про закрытие ни слова', () => {
    const department: ITimesheetSalaryResponse = {
      ...data, month: '2026-09', kind: 'department', state: null, distribution: null, as_of: '2026-09-30',
    };
    const row = {
      employee_id: 71, ktu: null, counted_hours: null, amount: '251500.00', share: null, deducted: '1200.00',
      missing: ['vacation_pay' as const], payout_state: 'preliminary' as const, source: null, can_edit: false,
    };
    expect(plain(salaryAmountTitle(department, row)))
      .toBe('К выплате (ФОТ) · удержано 1 200,00 · без: отпускные');
  });
});

describe('приглушение сумм', () => {
  const department: ITimesheetSalaryResponse = {
    ...data, month: '2026-10', kind: 'department', state: null, distribution: null, as_of: '2026-10-27',
  };
  const row = {
    employee_id: 71, ktu: null, counted_hours: null, amount: '251500.00', share: null, deducted: '0.00',
    missing: [], payout_state: 'preliminary' as const, source: null, can_edit: false,
  };

  it('отдел — никогда, закрыт табель или нет; бригада — только «Требует перерасчёта»', () => {
    expect(isSalaryRowMuted(department, row)).toBe(false);
    expect(isSalaryRowMuted(department, { ...row, payout_state: 'closed' })).toBe(false);
    expect(isSalaryRowMuted(department, { ...row, payout_state: 'not_closed' })).toBe(false);
    expect(isSalaryRowMuted(data, data.rows[0])).toBe(false);
    expect(isSalaryRowMuted({ ...data, state: 'stale' }, data.rows[0])).toBe(true);
    expect(isSalaryRowMuted(undefined, row)).toBe(false);
    expect(isSalaryRowMuted(department, null)).toBe(false);
  });
});

describe('«Оклад» и «Переработка» отдела', () => {
  const row = {
    employee_id: 1428, ktu: null, counted_hours: null, amount: '255570.91', share: null, deducted: '0.00',
    missing: [], payout_state: 'closed' as const, source: null, can_edit: false,
  };
  const contract = { code: 'contract' as const, amount: '250000.00', days: { worked: 22, norm: 22 } };
  const overtime = { code: 'overtime' as const, amount: '2840.91', days: { worked: 0, norm: 22 }, hours: 2 };

  it('строка есть — из скольких дней или часов, закрыт табель или нет', () => {
    expect(salaryLineTitle(row, contract)).toBe('22 из 22 дн.');
    expect(salaryLineTitle(row, overtime)).toBe('2 ч');
    expect(salaryLineTitle({ ...row, payout_state: 'preliminary' }, contract)).toBe('22 из 22 дн.');
  });

  it('строки нет или посчитать нечем — без подсказки', () => {
    expect(salaryLineTitle({ ...row, payout_state: 'not_closed' }, null)).toBeUndefined();
    expect(salaryLineTitle(row, null)).toBeUndefined();
    expect(salaryLineTitle(row, undefined)).toBeUndefined();
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

describe('«Зарплата по объектам» (336)', () => {
  const wave: ITimesheetSalaryObject = {
    object_key: 'wave', object_name: 'ЖК Wave', output_amount: '228000.00', state: 'ok',
    total_hours: 22, total_weight: 22_800,
    members: [
      { employee_id: 1, days: { '2026-09-01': 12 }, hours: 12, counted_minutes: 600, weight: 6000, share: '60000.00' },
      { employee_id: 2, days: { '2026-09-01': 6, '2026-09-16': 12 }, hours: 18, counted_minutes: 1080, weight: 10_800, share: '108000.00' },
    ],
  };
  const stories: ITimesheetSalaryObject = {
    object_key: 'stories', object_name: 'ЖК Stories', output_amount: null, state: 'no_output',
    total_hours: 14, total_weight: 8400,
    members: [
      { employee_id: 2, days: { '2026-09-01': 4 }, hours: 4, counted_minutes: 240, weight: 2400, share: null },
    ],
  };
  const alia: ITimesheetSalaryObject = {
    object_key: 'alia', object_name: 'ЖК Alia', output_amount: '5000.00', state: 'nothing_to_distribute',
    total_hours: 0, total_weight: 0, members: [],
  };
  const brigade: ITimesheetSalaryResponse = {
    ...data,
    state: 'fixed',
    distribution: 'no_output',
    computed_at: '2026-10-27T11:16:00.000Z',
    objects: [alia, stories, wave],
    rows: [
      { employee_id: 2, full_name: 'Бобокулов Саид', ktu: '1.0', counted_hours: 22, amount: null, share: null, source: 'version', can_edit: true },
      { employee_id: 1, full_name: 'Абдуалимов Жахонгир', ktu: '1.0', counted_hours: 10, amount: '60000.00', share: '60000.00', source: 'version', can_edit: true },
    ],
  };

  it('подсказка доли — по весам ответа, до копейки; выработки нет — «не внесена»; часов нет — без подсказки', () => {
    expect(objectShareTitle(wave, wave.members[0]))
      .toBe(`228${NBSP}000,00 × КТУ 1 × 10 ч / 38 (Σ КТУ × ч объекта) = 60${NBSP}000,00`);
    expect(objectShareTitle(stories, stories.members[0])).toBe('выработка не внесена');
    expect(objectShareTitle(wave, { ...wave.members[0], counted_minutes: 0 })).toBeUndefined();
  });

  it('пометка объекта, выработку без часов — только стереть', () => {
    expect(salaryObjectStateNote(stories)).toBe('не внесена');
    expect(salaryObjectStateNote(alia)).toBe('некому распределить — часов нет');
    expect(salaryObjectStateNote(wave)).toBeNull();
    expect(isOutputClearOnly(alia)).toBe(true);
    expect(isOutputClearOnly(wave)).toBe(false);
  });

  it('«Сумма» без доли — какие объекты не внесены; часы по дням — Σ по объектам', () => {
    expect(missingObjectsNote(brigade, 2)).toBe('выработка не внесена: ЖК Stories');
    expect(missingObjectsNote(brigade, 1)).toBeNull();
    expect(salaryAmountTitle(brigade, brigade.rows[0])).toContain('выработка не внесена: ЖК Stories');
    expect(totalDaysOfEmployee(brigade, 2)).toEqual({ '2026-09-01': 10, '2026-09-16': 12 });
  });

  it('сумма бригаде (341): объекты только для показа — ни «не внесена», ни формулы объекта', () => {
    const byBrigade = (object: ITimesheetSalaryObject): ITimesheetSalaryObject => ({
      ...object, output_amount: null, state: 'by_brigade', total_weight: 0,
      members: object.members.map(member => ({ ...member, share: null })),
    });
    const whole: ITimesheetSalaryResponse = {
      ...brigade, distribution: 'ok', output_mode: 'brigade', brigade_output: '312000.00', output_amount: '312000.00',
      objects: [byBrigade(stories), byBrigade(wave)],
    };
    expect(salaryObjectStateNote(whole.objects![1])).toBeNull();
    expect(objectShareTitle(whole.objects![1], whole.objects![1].members[0])).toBeUndefined();
    expect(missingObjectsNote(whole, 2)).toBeNull();
    expect(salaryAmountTitle(whole, { ...brigade.rows[0], share: null })).not.toContain('выработка не внесена');
  });

  it('часы — целыми, как в сетке табеля; «Часы» — сумма видимых цифр; день по объектам округляется после сложения', () => {
    // Рахмонзода 17.10: 8,5 → 9; Ковальчук 22.10: 0,42 → 0.
    expect(formatDayHours(8.5)).toBe('9');
    expect(formatDayHours(0.42)).toBe('0');
    expect(formatDayHours(9.05)).toBe('9');
    expect(formatDayHours(undefined)).toBe('');
    expect(displayedHours({ '2026-10-17': 8.5, '2026-10-20': 8.15, '2026-10-22': 0.42 })).toBe(9 + 8 + 0);
    const split: ITimesheetSalaryResponse = {
      ...brigade,
      objects: [
        { ...wave, members: [{ ...wave.members[0], employee_id: 5, days: { '2026-09-02': 4.4 } }] },
        { ...stories, members: [{ ...stories.members[0], employee_id: 5, days: { '2026-09-02': 4.4 } }] },
      ],
    };
    // 4,4 + 4,4 = 8,8 → в «Итого» 9, а не 4 + 4.
    expect(displayedHours(totalDaysOfEmployee(split, 5))).toBe(9);
  });

  it('рабочие — по ФИО; состояние бригады и ошибка настройки объекта без даты', () => {
    expect(sortSalaryRows(brigade.rows).map(row => row.employee_id)).toEqual([1, 2]);
    // Закрыт табель или нет — не пишем; остаются только предупреждения.
    expect(describeSalaryState(brigade)).toBeNull();
    expect(describeSalaryState({ ...brigade, state: 'preliminary', as_of: '2026-10-28' })).toBeNull();
    expect(describeSalaryState({ ...brigade, state: 'stale' })).toEqual({ text: 'Требует перерасчёта — табель открыт', tone: 'warn' });
    const failed: ITimesheetSalaryResponse = {
      ...brigade,
      distribution: 'error',
      errors: [{ employee_id: 2, full_name: 'Бобокулов Саид Эргашевич', code: 'object_config', date: null }],
    };
    expect(describeSalaryState(failed)).toEqual({
      text: 'Ошибка: не задан объект табелирования — Бобокулов С. Э.',
      tone: 'error',
      title: 'Бобокулов С. Э.: не задан объект табелирования',
    });
  });
});
