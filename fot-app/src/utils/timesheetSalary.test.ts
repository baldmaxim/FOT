import { describe, expect, it } from 'vitest';

import type { TimesheetEmployee, TimesheetStatus } from '../types';
import type { ITimesheetSalaryObject, ITimesheetSalaryResponse } from '../types/timesheet';
import {
  averagePerHour, averageTitle, countedHoursLabel, describeSalaryState, displayedHours, employeeCountedMinutes, findSalaryRow, formatDayHours,
  formatKtu, formatSalaryAmount, getSalaryLetterHours, isOutputClearOnly, isSalaryRowMuted, memberAverage, missingObjectsNote, objectAverage,
  objectCountedMinutes, objectShareTitle, rowAverage, salaryAmountTitle, salaryLineTitle, salaryObjectStateNote, salaryOvertimeNote,
  sortSalaryRows, totalDaysOfEmployee,
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

describe('средняя в час — по учтённым минутам', () => {
  // Числа настоящего расчёта: бр.Менгбоев, октябрь 2026. У Асадбоева два объекта, на Метрополии часы другие.
  const dom: ITimesheetSalaryObject = {
    object_key: 'dom56', object_name: 'ЖК Дом 56', output_amount: '6000000.00', state: 'ok',
    total_hours: 12550, total_weight: 7_076_230,
    members: [
      { employee_id: 1, days: { '2026-10-01': 358 }, hours: 358, counted_minutes: 18_480, weight: 184_800, share: '156693.61' },
      { employee_id: 2, days: { '2026-10-01': 23 }, hours: 23, counted_minutes: 1320, weight: 13_200, share: '11192.40' },
      { employee_id: 3, days: { '2026-10-01': 12169 }, hours: 12169, counted_minutes: 687_823, weight: 6_878_230, share: '5832113.99' },
    ],
  };
  const metropolia: ITimesheetSalaryObject = {
    object_key: 'metropolia', object_name: 'ЖК Метрополия', output_amount: '500000.00', state: 'ok',
    total_hours: 197, total_weight: 118_000,
    members: [
      { employee_id: 2, days: { '2026-10-02': 197 }, hours: 197, counted_minutes: 11_800, weight: 118_000, share: '111287.16' },
    ],
  };
  const unknown: ITimesheetSalaryObject = {
    object_key: '__unknown_object__', object_name: 'Не определён', output_amount: '900000.00', state: 'nothing_to_distribute',
    total_hours: 1551, total_weight: 0,
    members: [
      { employee_id: 1, days: { '2026-10-03': 11 }, hours: 11, counted_minutes: 0, weight: 0, share: null },
    ],
  };
  const row = (employee_id: number, share: string | null) => ({
    employee_id, full_name: `Рабочий ${employee_id}`, ktu: '1.0', counted_hours: 1, amount: share, share, source: 'live' as const, can_edit: false,
  });
  const brigade: ITimesheetSalaryResponse = {
    ...data,
    objects: [dom, metropolia, unknown],
    rows: [row(1, '156693.61'), row(2, '122479.56'), row(3, '5832113.99')],
  };

  it('сумма ÷ минуты, округление одно до копейки', () => {
    expect(averagePerHour('6000000.00', 707_623)).toBe('508.75');
    expect(averagePerHour('156693.61', 18_480)).toBe('508.75');
    expect(averagePerHour('100.00', 180)).toBe('33.33');
    expect(averagePerHour('1000.00', 7)).toBe('8571.43');
  });

  it('нет суммы или минут — null; внесённый 0,00 при часах — 0,00', () => {
    expect(averagePerHour(null, 600)).toBeNull();
    expect(averagePerHour(undefined, 600)).toBeNull();
    expect(averagePerHour('100.00', 0)).toBeNull();
    expect(averagePerHour('100.00', -1)).toBeNull();
    expect(averagePerHour('0.00', 600)).toBe('0.00');
  });

  it('заголовок объекта, строка и «Итого» считаются из одних минут: Σ строк = заголовок, Σ объектов = итог', () => {
    expect(objectCountedMinutes(dom)).toBe(707_623);
    expect(dom.members.reduce((sum, member) => sum + member.counted_minutes, 0)).toBe(objectCountedMinutes(dom));
    expect(employeeCountedMinutes(brigade, 2)).toBe(13_120);
    expect(objectAverage(dom)).toBe('508.75');
    expect(memberAverage(dom.members[0])).toBe('508.75');
    expect(memberAverage(dom.members[1])).toBe('508.75');
    expect(memberAverage(metropolia.members[0])).toBe('565.87');
    expect(rowAverage(brigade, brigade.rows[1])).toBe('560.12');
  });

  it('фактические часы на средней не сказываются: другие «Часы» при тех же минутах — та же средняя', () => {
    const member = dom.members[0];
    expect(memberAverage({ ...member, days: { '2026-10-01': 300 }, hours: 300 })).toBe(memberAverage(member));
  });

  it('повторный расчёт даёт то же и не меняет данные', () => {
    const before = JSON.stringify(brigade);
    const first = [objectAverage(dom), memberAverage(dom.members[0]), rowAverage(brigade, brigade.rows[1])];
    const second = [objectAverage(dom), memberAverage(dom.members[0]), rowAverage(brigade, brigade.rows[1])];
    expect(second).toEqual(first);
    expect(JSON.stringify(brigade)).toBe(before);
  });

  it('выработка внесена, а делить не на кого: средней нет, сколько бы часов ни было на экране', () => {
    expect(objectAverage(unknown)).toBeNull();
    expect(memberAverage(unknown.members[0])).toBeNull();
    expect(objectAverage({ ...unknown, members: [] })).toBeNull();
  });

  it('выработка не внесена или расчёт с ошибкой (долей нет): средней объекта нет', () => {
    const noShares = { ...dom, members: dom.members.map(member => ({ ...member, share: null })) };
    expect(objectAverage({ ...noShares, output_amount: null, state: 'no_output' })).toBeNull();
    expect(objectAverage(noShares)).toBeNull();
  });

  it('внесённый 0,00 распределён: средняя 0,00', () => {
    const zero = { ...dom, output_amount: '0.00', members: dom.members.map(member => ({ ...member, share: '0.00' })) };
    expect(objectAverage(zero)).toBe('0.00');
    expect(memberAverage(zero.members[0])).toBe('0.00');
  });

  it('у рабочего объект без выработки: в «Итого» доли нет — и средней нет; строка объекта с долей считается', () => {
    const partial: ITimesheetSalaryResponse = { ...brigade, rows: [row(2, null)] };
    expect(rowAverage(partial, partial.rows[0])).toBeNull();
    expect(memberAverage(dom.members[1])).toBe('508.75');
  });

  it('выработка одной суммой на бригаду: у объекта и строки средней нет, в «Итого» есть', () => {
    const byBrigade = (object: ITimesheetSalaryObject): ITimesheetSalaryObject => ({
      ...object, output_amount: null, state: 'by_brigade', total_weight: 0,
      members: object.members.map(member => ({ ...member, share: null })),
    });
    const whole: ITimesheetSalaryResponse = {
      ...brigade, output_mode: 'brigade', brigade_output: '612000.00', objects: [byBrigade(dom), byBrigade(metropolia)],
    };
    expect(objectAverage(whole.objects![0])).toBeNull();
    expect(memberAverage(whole.objects![0].members[1])).toBeNull();
    expect(rowAverage(whole, whole.rows[1])).toBe('560.12');
  });

  it('подписи: часы до сотых, в подсказке точные минуты', () => {
    expect(countedHoursLabel(707_623)).toBe('11793,72 ч');
    expect(countedHoursLabel(18_480)).toBe('308 ч');
    expect(averageTitle('156693.61', 18_480)).toBe(`156${NBSP}693,61 ÷ 308 учтённых ч (18480 мин)`);
    expect(averageTitle(null, 18_480)).toBeUndefined();
    expect(averageTitle('156693.61', 0)).toBeUndefined();
  });
});
