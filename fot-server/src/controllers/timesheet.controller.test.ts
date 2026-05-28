import { describe, expect, it } from 'vitest';
import { isMandatoryWeekendSlotAvailable } from './timesheet.controller.js';

const baseSchedule = {
  pattern_type: '5+2',
  expected_saturdays_per_month: 2,
  expected_sundays_per_month: 0,
  respects_holidays: true,
};

const dateOf = (iso: string): Date => new Date(`${iso}T00:00:00`);

describe('isMandatoryWeekendSlotAvailable — субботы', () => {
  it('допускает 1-ю субботу при норме 2 (used=0)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(baseSchedule, '2026-05-02', dateOf('2026-05-02'), null, 0, 6),
    ).toBe(true);
  });

  it('допускает 2-ю субботу при норме 2 (used=1)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(baseSchedule, '2026-05-09', dateOf('2026-05-09'), null, 1, 6),
    ).toBe(true);
  });

  it('блокирует 3-ю субботу при норме 2 (used=2)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(baseSchedule, '2026-05-16', dateOf('2026-05-16'), null, 2, 6),
    ).toBe(false);
  });

  it('не зачитывает воскресенье при dow=6', () => {
    expect(
      isMandatoryWeekendSlotAvailable(baseSchedule, '2026-05-03', dateOf('2026-05-03'), null, 0, 6),
    ).toBe(false);
  });

  it('не зачитывает субботу-обязательный праздник (mandatory_holidays)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        baseSchedule,
        '2026-03-07',
        dateOf('2026-03-07'),
        { mandatory_holidays: ['2026-03-07'], holidays: [] },
        0,
        6,
      ),
    ).toBe(false);
  });

  it('не зачитывает субботу-праздник (holidays) при respects_holidays=true', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        baseSchedule,
        '2026-05-09',
        dateOf('2026-05-09'),
        { mandatory_holidays: [], holidays: ['2026-05-09'] },
        0,
        6,
      ),
    ).toBe(false);
  });

  it('зачитывает субботу-праздник при respects_holidays=false (для holidays)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, respects_holidays: false },
        '2026-05-09',
        dateOf('2026-05-09'),
        { mandatory_holidays: [], holidays: ['2026-05-09'] },
        0,
        6,
      ),
    ).toBe(true);
  });

  it('mandatory_holidays блокируют независимо от respects_holidays', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, respects_holidays: false },
        '2026-03-07',
        dateOf('2026-03-07'),
        { mandatory_holidays: ['2026-03-07'], holidays: [] },
        0,
        6,
      ),
    ).toBe(false);
  });

  it('работает для любого pattern_type при expected_saturdays_per_month>0 (5+0)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, pattern_type: '5+0' },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
        6,
      ),
    ).toBe(true);
  });

  it('не работает при expected_saturdays_per_month=0', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, expected_saturdays_per_month: 0 },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
        6,
      ),
    ).toBe(false);
  });

  it('работает для cycle-графика с обязательными субботами (used<норма)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, pattern_type: 'cycle' },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
        6,
      ),
    ).toBe(true);
  });

  it('cycle-график: блокирует субботу сверх нормы (used>=норма)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...baseSchedule, pattern_type: 'cycle' },
        '2026-05-16',
        dateOf('2026-05-16'),
        null,
        2,
        6,
      ),
    ).toBe(false);
  });
});

describe('isMandatoryWeekendSlotAvailable — воскресенья', () => {
  const sundaySchedule = {
    pattern_type: '5+2',
    expected_saturdays_per_month: 0,
    expected_sundays_per_month: 2,
    respects_holidays: true,
  };

  it('допускает 1-е воскресенье при норме 2 (used=0)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(sundaySchedule, '2026-05-03', dateOf('2026-05-03'), null, 0, 0),
    ).toBe(true);
  });

  it('допускает 2-е воскресенье при норме 2 (used=1)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(sundaySchedule, '2026-05-10', dateOf('2026-05-10'), null, 1, 0),
    ).toBe(true);
  });

  it('блокирует 3-е воскресенье при норме 2 (used=2)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(sundaySchedule, '2026-05-17', dateOf('2026-05-17'), null, 2, 0),
    ).toBe(false);
  });

  it('не зачитывает субботу при dow=0', () => {
    expect(
      isMandatoryWeekendSlotAvailable(sundaySchedule, '2026-05-02', dateOf('2026-05-02'), null, 0, 0),
    ).toBe(false);
  });

  it('не работает при expected_sundays_per_month=0', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        { ...sundaySchedule, expected_sundays_per_month: 0 },
        '2026-05-03',
        dateOf('2026-05-03'),
        null,
        0,
        0,
      ),
    ).toBe(false);
  });

  it('не зачитывает праздничное воскресенье (mandatory_holidays)', () => {
    expect(
      isMandatoryWeekendSlotAvailable(
        sundaySchedule,
        '2026-03-08',
        dateOf('2026-03-08'),
        { mandatory_holidays: ['2026-03-08'], holidays: [] },
        0,
        0,
      ),
    ).toBe(false);
  });

  it('счётчик норм субботы и воскресенья независимы (Сб=2, Вс=1 — Вс блок-н после 1)', () => {
    const both = { ...sundaySchedule, expected_saturdays_per_month: 2, expected_sundays_per_month: 1 };
    expect(
      isMandatoryWeekendSlotAvailable(both, '2026-05-10', dateOf('2026-05-10'), null, 1, 0),
    ).toBe(false);
    expect(
      isMandatoryWeekendSlotAvailable(both, '2026-05-09', dateOf('2026-05-09'), null, 1, 6),
    ).toBe(true);
  });
});
