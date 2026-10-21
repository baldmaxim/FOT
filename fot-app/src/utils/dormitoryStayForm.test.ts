import { describe, expect, it } from 'vitest';

import {
  DORMITORY_PRESET_ADDRESSES,
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
      payload: { check_in: '2026-10-01', check_out: null, address: 'Общежитие №2, комн. 14', amount: null },
    });
  });

  it('квартира: сумма обязательна и больше нуля, адрес — по желанию (пусто — null)', () => {
    const flat = { checkIn: '2026-10-01', checkOut: '', address: '  ', amount: '1 250,5' };
    expect(parseDormitoryStay(flat, picked, 'apartment')).toEqual({
      ok: true,
      payload: { check_in: '2026-10-01', check_out: null, address: null, amount: 1250.5 },
    });
    expect(parseDormitoryStay({ ...flat, address: ' ул. Рабочая,  5 ' }, picked, 'apartment'))
      .toMatchObject({ ok: true, payload: { address: 'ул. Рабочая, 5' } });
    for (const amount of ['', '0', '-5', '10,555', 'abc']) {
      expect(parseDormitoryStay({ ...flat, amount }, picked, 'apartment'), amount).toMatchObject({ ok: false, field: 'amount' });
    }
    expect(parseDormitoryStay({ ...flat, address: 'а'.repeat(201) }, picked, 'apartment')).toMatchObject({ field: 'address' });
    // У общежития сумма не читается.
    expect(parseDormitoryStay({ ...draft, amount: '999' }, picked)).toMatchObject({ ok: true, payload: { amount: null } });
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

  it('общежития компании без проживаний — все; совпавший сохранённый адрес не повторяется', () => {
    expect(dormitoryAddressOptions(DORMITORY_PRESET_ADDRESSES)).toHaveLength(DORMITORY_PRESET_ADDRESSES.length);
    expect(dormitoryAddressOptions([...DORMITORY_PRESET_ADDRESSES, 'общ. база химки', 'Общ1']))
      .toHaveLength(DORMITORY_PRESET_ADDRESSES.length + 1);
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
