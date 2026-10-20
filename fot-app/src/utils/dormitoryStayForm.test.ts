import { describe, expect, it } from 'vitest';

import {
  dormitoryAddressOptions,
  filterDormitoryAddresses,
  isCalendarDate,
  parseDormitoryStay,
} from './dormitoryStayForm';

const draft = { checkIn: '2026-10-01', checkOut: '', address: '  Общежитие №2,  комн. 14 ' };
const picked = { required: true, selected: true };

describe('isCalendarDate', () => {
  it('настоящие даты — да; 31.02, 13-й месяц, неполная — нет', () => {
    expect(isCalendarDate('2026-10-01')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('')).toBe(false);
  });
});

describe('parseDormitoryStay', () => {
  it('без выезда — живёт (null); адрес без лишних пробелов', () => {
    expect(parseDormitoryStay(draft, picked)).toEqual({
      ok: true,
      payload: { check_in: '2026-10-01', check_out: null, address: 'Общежитие №2, комн. 14' },
    });
  });

  it('выезд строго позже въезда; день в день — нельзя', () => {
    expect(parseDormitoryStay({ ...draft, checkOut: '2026-10-02' }, picked)).toMatchObject({ ok: true });
    expect(parseDormitoryStay({ ...draft, checkOut: '2026-10-01' }, picked)).toMatchObject({ ok: false, field: 'check_out' });
    expect(parseDormitoryStay({ ...draft, checkOut: '2026-09-30' }, picked)).toMatchObject({ ok: false, field: 'check_out' });
  });

  it('по порядку полей: сотрудник, въезд, выезд, адрес', () => {
    expect(parseDormitoryStay(draft, { required: true, selected: false })).toMatchObject({ field: 'employee' });
    // В правке сотрудник не меняется — не требуется.
    expect(parseDormitoryStay(draft, { required: false, selected: false })).toMatchObject({ ok: true });
    expect(parseDormitoryStay({ ...draft, checkIn: '' }, picked)).toMatchObject({ field: 'check_in', message: 'Укажите дату въезда' });
    expect(parseDormitoryStay({ ...draft, checkIn: '2026-02-31' }, picked)).toMatchObject({ field: 'check_in', message: 'Такой даты нет' });
    expect(parseDormitoryStay({ ...draft, checkOut: '2026-11-31' }, picked)).toMatchObject({ field: 'check_out' });
    expect(parseDormitoryStay({ ...draft, address: '   ' }, picked)).toMatchObject({ field: 'address' });
    expect(parseDormitoryStay({ ...draft, address: 'а'.repeat(201) }, picked)).toMatchObject({ field: 'address' });
  });
});

describe('dormitoryAddressOptions', () => {
  it('без повторов: регистр и пробелы не в счёт, остаётся самое частое написание', () => {
    expect(dormitoryAddressOptions(['общ1', ' Общ1 ', 'Общ1', 'Абай  5', '  '])).toEqual(['Абай 5', 'Общ1']);
  });

  it('числа по значению: Общ2 раньше Общ10', () => {
    expect(dormitoryAddressOptions(['Общ10', 'Общ2', 'Абай 5'])).toEqual(['Абай 5', 'Общ2', 'Общ10']);
  });
});

describe('filterDormitoryAddresses', () => {
  const options = ['Общ1', 'Общ10', 'Абай 5'];

  it('пусто — все; иначе содержащие введённое без учёта регистра', () => {
    expect(filterDormitoryAddresses(options, '  ')).toEqual(options);
    expect(filterDormitoryAddresses(options, 'абай')).toEqual(['Абай 5']);
    expect(filterDormitoryAddresses(options, 'Общ2')).toEqual([]);
  });

  it('ровно введённый адрес не показываем', () => {
    expect(filterDormitoryAddresses(options, 'общ1 ')).toEqual(['Общ10']);
  });
});
