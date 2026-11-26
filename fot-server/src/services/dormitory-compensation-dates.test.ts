import { describe, expect, it } from 'vitest';

import {
  assertClosedMonthsKept,
  closedDaysOf,
  closedMonthsChange,
  closedMonthsMessage,
  CompensationClosedMonthsError,
  compensationOpenFrom,
  resolveCompensationStart,
} from './dormitory-compensation-dates.js';

// Ноябрь 2026 после 10-го: открыт только ноябрь (с 01.11).
const NOV = '2026-11-01';

describe('compensationOpenFrom: прошлый месяц открыт по 10-е число включительно', () => {
  it('11-е и позже — текущий месяц, по 10-е — прошлый; январь — декабрь прошлого года', () => {
    expect(compensationOpenFrom('2026-11-26')).toBe('2026-11-01');
    expect(compensationOpenFrom('2026-11-11')).toBe('2026-11-01');
    expect(compensationOpenFrom('2026-12-10')).toBe('2026-11-01');
    expect(compensationOpenFrom('2026-12-01')).toBe('2026-11-01');
    expect(compensationOpenFrom('2026-12-11')).toBe('2026-12-01');
    expect(compensationOpenFrom('2027-01-05')).toBe('2026-12-01');
  });
});

describe('closedDaysOf: дни записи в закрытых месяцах', () => {
  it('с 01.09.2026 (раньше ФОТ не считал) до начала открытого периода или окончания', () => {
    expect(closedDaysOf({ check_in: '2026-09-01', check_out: null }, NOV)).toEqual({ from: '2026-09-01', to: NOV });
    expect(closedDaysOf({ check_in: '2018-09-01', check_out: null }, NOV)).toEqual({ from: '2026-09-01', to: NOV });
    expect(closedDaysOf({ check_in: '2026-09-01', check_out: '2026-10-01' }, NOV)).toEqual({ from: '2026-09-01', to: '2026-10-01' });
  });

  it('запись только в открытом периоде или до 01.09.2026 — нет', () => {
    expect(closedDaysOf({ check_in: NOV, check_out: null }, NOV)).toBeNull();
    expect(closedDaysOf({ check_in: '2026-11-24', check_out: null }, NOV)).toBeNull();
    expect(closedDaysOf({ check_in: '2018-09-01', check_out: '2026-02-19' }, NOV)).toBeNull();
  });
});

describe('resolveCompensationStart: «Начало» раньше открытого периода — справочное', () => {
  it('новая запись: Абдухалимов с 19.04.2023 — расчёт с 01.11.2026, начало справочно; с 15.11 — как есть', () => {
    expect(resolveCompensationStart('2023-04-19', NOV, null)).toEqual({ check_in: NOV, since_on: '2023-04-19' });
    expect(resolveCompensationStart('2026-11-15', NOV, null)).toEqual({ check_in: '2026-11-15', since_on: null });
  });

  it('правка: Смирнов (с 01.09.2026) — начало 08.10.2024 справочно, расчёт прежний', () => {
    const before = { check_in: '2026-09-01', since_on: null };
    expect(resolveCompensationStart('2024-10-08', NOV, before)).toEqual({ check_in: '2026-09-01', since_on: '2024-10-08' });
  });

  it('правка без смены «Начала» — справочное прежнее (окно показывает since_on, прежний клиент — check_in)', () => {
    const before = { check_in: '2026-09-01', since_on: '2024-10-08' };
    expect(resolveCompensationStart('2024-10-08', NOV, before)).toEqual({ check_in: '2026-09-01', since_on: '2024-10-08' });
    expect(resolveCompensationStart('2026-09-01', NOV, before)).toEqual({ check_in: '2026-09-01', since_on: '2024-10-08' });
  });

  it('прежнее начало в открытом периоде, введено раньше — расчёт с начала периода; позже — как введено', () => {
    const before = { check_in: '2026-11-15', since_on: null };
    expect(resolveCompensationStart('2026-10-01', NOV, before)).toEqual({ check_in: NOV, since_on: '2026-10-01' });
    expect(resolveCompensationStart('2026-11-20', NOV, before)).toEqual({ check_in: '2026-11-20', since_on: null });
  });

  it('сдвиг начала позже внутри закрытых месяцев — как введено (отклонит проверка закрытых месяцев)', () => {
    const before = { check_in: '2026-09-01', since_on: null };
    const start = resolveCompensationStart('2026-10-15', NOV, before);
    expect(start).toEqual({ check_in: '2026-10-15', since_on: null });
    expect(closedMonthsChange({ check_in: '2026-09-01', check_out: null }, { check_in: start.check_in, check_out: null }, NOV))
      .toBe('check_in');
  });
});

describe('closedMonthsChange / assertClosedMonthsKept', () => {
  const open = { check_in: '2026-09-01', check_out: null };

  it('Киличов Ш.: «Окончание» 19.02.2026 у записи с сентября — «Окончание»', () => {
    expect(closedMonthsChange(open, { check_in: '2026-09-01', check_out: '2026-02-19' }, NOV)).toBe('check_out');
  });

  it('Барабаш: пауза с 01.10 — отказ; с 01.11 и позже — можно', () => {
    expect(closedMonthsChange(open, { check_in: '2026-09-01', check_out: '2026-10-01' }, NOV)).toBe('check_out');
    expect(closedMonthsChange(open, { check_in: '2026-09-01', check_out: NOV }, NOV)).toBeNull();
    expect(closedMonthsChange(open, { check_in: '2026-09-01', check_out: '2026-11-20' }, NOV)).toBeNull();
  });

  it('снять окончание паузы до открытого периода — отказ; паузы в открытом периоде — можно', () => {
    expect(closedMonthsChange({ check_in: '2026-09-01', check_out: '2026-10-01' }, open, NOV)).toBe('check_out');
    expect(closedMonthsChange({ check_in: '2026-09-01', check_out: '2026-11-20' }, open, NOV)).toBeNull();
  });

  it('новая запись с началом в закрытом месяце — отказ «Начало»; в открытом — можно', () => {
    expect(closedMonthsChange(null, { check_in: '2026-10-01', check_out: null }, NOV)).toBe('check_in');
    expect(closedMonthsChange(null, { check_in: NOV, check_out: null }, NOV)).toBeNull();
  });

  it('1–10 декабря ноябрь ещё открыт: пауза с 25.11 — можно; с 11.12 — нет', () => {
    expect(closedMonthsChange(open, { check_in: '2026-09-01', check_out: '2026-11-25' }, compensationOpenFrom('2026-12-05')))
      .toBeNull();
    expect(closedMonthsChange(open, { check_in: '2026-09-01', check_out: '2026-11-25' }, compensationOpenFrom('2026-12-11')))
      .toBe('check_out');
  });

  it('ошибка — с текстом по полю и датой начала открытого периода', () => {
    expect(() => assertClosedMonthsKept(open, { check_in: '2026-09-01', check_out: '2026-10-01' }, NOV))
      .toThrow(CompensationClosedMonthsError);
    expect(() => assertClosedMonthsKept(open, { check_in: '2026-09-01', check_out: '2026-10-01' }, NOV))
      .toThrow('Месяцы до 01.11.2026 закрыты — компенсация за них уже рассчитана: «Окончание» — не раньше 01.11.2026');
    expect(closedMonthsMessage('delete', NOV)).toContain('поставьте «Окончание»');
    expect(() => assertClosedMonthsKept(open, { check_in: '2026-09-01', check_out: '2026-11-30' }, NOV)).not.toThrow();
  });
});
