import { describe, expect, it } from 'vitest';

import { isCalendarDate, parseDormitoryStay } from './dormitoryStayForm';

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
