import { describe, expect, it } from 'vitest';

import type { TimesheetEntry } from '../types';
import { getDayStatus } from './dayStatus';

/**
 * Полный день — по целым часам, как в зарплате по часам и «Едином 1С»: часы дня, округлённые до целого, не меньше
 * округлённой нормы графика — день зелёный, даже если человек опоздал, ушёл раньше или выходил дольше обеда.
 */

const work = (hours: number, extra: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: null,
  employee_id: 1,
  work_date: '2026-11-13',
  status: 'work',
  hours_worked: hours,
  display_hours_worked: hours,
  is_correction: false,
  first_entry: '09:03:00',
  last_exit: '17:55:00',
  presence_covers_shift: false,
  underwork_reason: 'short_span',
  ...extra,
} as TimesheetEntry);

const status = (entry: TimesheetEntry, dayNormHours?: number, fullDayThresholdHours = 8) => getDayStatus(entry, {
  showActualHours: true,
  fullDayThresholdHours,
  dayNormHours,
  isScheduledDayOff: false,
});

describe('getDayStatus: полный день по целым часам', () => {
  it('7 ч 52 мин при норме 8 (Рацкевич 13.11) — полный день', () => {
    expect(status(work(7 + 52 / 60), 8)).toBe('present');
  });

  it('7 ч 29 мин при норме 8 — недобор', () => {
    expect(status(work(7 + 29 / 60), 8)).toBe('underwork');
  });

  it('ровно 7 ч 30 мин округляется вверх — полный день', () => {
    expect(status(work(7.5), 8)).toBe('present');
  });

  it('длинный перерыв при полных часах (11 ч при норме 10) — полный день', () => {
    expect(status(work(11, { underwork_reason: 'long_break' }), 10, 10)).toBe('present');
  });

  it('длинный перерыв с недобором — «Длинный перерыв»', () => {
    expect(status(work(6, { underwork_reason: 'long_break' }), 8)).toBe('long_break');
  });

  it('короткое присутствие с полными часами — полный день', () => {
    expect(status(work(8.6), 8)).toBe('present');
  });

  it('предпраздничный день, норма 7: 6 ч 40 мин — полный день, 6 ч 20 мин — недобор', () => {
    expect(status(work(6 + 40 / 60), 7, 7)).toBe('present');
    expect(status(work(6 + 20 / 60), 7, 7)).toBe('underwork');
  });

  it('без нормы — прежнее правило: часы ниже порога или смена не покрыта — недобор', () => {
    expect(status(work(7 + 52 / 60))).toBe('underwork');
    expect(status(work(8.6))).toBe('underwork');
  });

  it('норма 0 (нет графика) — правило не действует', () => {
    expect(status(work(7 + 52 / 60), 0)).toBe('underwork');
  });

  it('проход без часов — «СКУД без пары», норма не влияет', () => {
    expect(status(work(0, { last_exit: null }), 8)).toBe('incomplete_skud');
  });
});
