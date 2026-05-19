import { describe, expect, it } from 'vitest';
import { isMandatorySaturdaySlotAvailable } from './timesheet.controller.js';

const baseSchedule = {
  pattern_type: '5+2',
  expected_saturdays_per_month: 2,
  respects_holidays: true,
};

const dateOf = (iso: string): Date => new Date(`${iso}T00:00:00`);

describe('isMandatorySaturdaySlotAvailable', () => {
  it('допускает 1-ю субботу при норме 2 (used=0)', () => {
    expect(
      isMandatorySaturdaySlotAvailable(baseSchedule, '2026-05-02', dateOf('2026-05-02'), null, 0),
    ).toBe(true);
  });

  it('допускает 2-ю субботу при норме 2 (used=1)', () => {
    expect(
      isMandatorySaturdaySlotAvailable(baseSchedule, '2026-05-09', dateOf('2026-05-09'), null, 1),
    ).toBe(true);
  });

  it('блокирует 3-ю субботу при норме 2 (used=2)', () => {
    expect(
      isMandatorySaturdaySlotAvailable(baseSchedule, '2026-05-16', dateOf('2026-05-16'), null, 2),
    ).toBe(false);
  });

  it('не зачитывает воскресенье', () => {
    expect(
      isMandatorySaturdaySlotAvailable(baseSchedule, '2026-05-03', dateOf('2026-05-03'), null, 0),
    ).toBe(false);
  });

  it('не зачитывает субботу-обязательный праздник (mandatory_holidays)', () => {
    expect(
      isMandatorySaturdaySlotAvailable(
        baseSchedule,
        '2026-03-07',
        dateOf('2026-03-07'),
        { mandatory_holidays: ['2026-03-07'], holidays: [] },
        0,
      ),
    ).toBe(false);
  });

  it('не зачитывает субботу-праздник (holidays) при respects_holidays=true', () => {
    expect(
      isMandatorySaturdaySlotAvailable(
        baseSchedule,
        '2026-05-09',
        dateOf('2026-05-09'),
        { mandatory_holidays: [], holidays: ['2026-05-09'] },
        0,
      ),
    ).toBe(false);
  });

  it('зачитывает субботу-праздник при respects_holidays=false (для holidays)', () => {
    expect(
      isMandatorySaturdaySlotAvailable(
        { ...baseSchedule, respects_holidays: false },
        '2026-05-09',
        dateOf('2026-05-09'),
        { mandatory_holidays: [], holidays: ['2026-05-09'] },
        0,
      ),
    ).toBe(true);
  });

  it('mandatory_holidays блокируют независимо от respects_holidays', () => {
    expect(
      isMandatorySaturdaySlotAvailable(
        { ...baseSchedule, respects_holidays: false },
        '2026-03-07',
        dateOf('2026-03-07'),
        { mandatory_holidays: ['2026-03-07'], holidays: [] },
        0,
      ),
    ).toBe(false);
  });

  it('работает для любого pattern_type при expected_saturdays_per_month>0 (5+0)', () => {
    expect(
      isMandatorySaturdaySlotAvailable(
        { ...baseSchedule, pattern_type: '5+0' },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
      ),
    ).toBe(true);
  });

  it('не работает при expected_saturdays_per_month=0', () => {
    expect(
      isMandatorySaturdaySlotAvailable(
        { ...baseSchedule, expected_saturdays_per_month: 0 },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
      ),
    ).toBe(false);
  });

  it('работает для cycle-графика с обязательными субботами (used<норма)', () => {
    expect(
      isMandatorySaturdaySlotAvailable(
        { ...baseSchedule, pattern_type: 'cycle' },
        '2026-05-02',
        dateOf('2026-05-02'),
        null,
        0,
      ),
    ).toBe(true);
  });

  it('cycle-график: блокирует субботу сверх нормы (used>=норма)', () => {
    expect(
      isMandatorySaturdaySlotAvailable(
        { ...baseSchedule, pattern_type: 'cycle' },
        '2026-05-16',
        dateOf('2026-05-16'),
        null,
        2,
      ),
    ).toBe(false);
  });
});
