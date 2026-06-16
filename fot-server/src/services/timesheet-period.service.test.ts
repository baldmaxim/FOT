import { describe, expect, it } from 'vitest';
import {
  buildTimesheetApprovalPeriod,
  getAllowedSubmissionPeriod,
  getAllowedSubmissionRange,
  getTimesheetReminderEventsForDate,
  isRangeSubmittable,
  parseTimesheetApprovalPeriod,
} from './timesheet-period.service.js';

describe('timesheet-period.service', () => {
  it('parses half-month approval period', () => {
    expect(parseTimesheetApprovalPeriod('2026-04-H1')).toEqual({ year: 2026, month: 4, half: 'H1' });
    expect(parseTimesheetApprovalPeriod('2026-04')).toBeNull();
  });

  const reminderSettings = {
    timezone: 'Europe/Moscow',
    openingReminderHour: 9,
    deadlineMorningHour: 10,
    deadlineAfternoonHour: 16,
    escalationHour: 17,
    overdueHour: 9,
  };

  it('first day of month: opening for previous H2 (window opens), overdue for previous H1', () => {
    const events = getTimesheetReminderEventsForDate(
      new Date('2026-05-01T09:30:00+03:00'),
      reminderSettings,
    );

    expect(events).toContainEqual({ period: '2026-04-H2', stage: 'opening' });
    expect(events).toContainEqual({ period: '2026-04-H1', stage: 'overdue' });
  });

  it('day 15: deadline chain for previous H2 (its submission window closes today)', () => {
    const events = getTimesheetReminderEventsForDate(
      new Date('2026-05-15T17:10:00+03:00'),
      reminderSettings,
    );

    expect(events).toContainEqual({ period: '2026-04-H2', stage: 'deadline_morning' });
    expect(events).toContainEqual({ period: '2026-04-H2', stage: 'deadline_afternoon' });
    expect(events).toContainEqual({ period: '2026-04-H2', stage: 'escalation' });
  });

  it('day 16: opening for current H1 (window opens), overdue for previous H2', () => {
    const events = getTimesheetReminderEventsForDate(
      new Date('2026-05-16T09:30:00+03:00'),
      reminderSettings,
    );

    expect(events).toContainEqual({ period: '2026-05-H1', stage: 'opening' });
    expect(events).toContainEqual({ period: '2026-04-H2', stage: 'overdue' });
  });

  it('builds deadline chain for current H1 on last day of month', () => {
    const events = getTimesheetReminderEventsForDate(
      new Date('2026-04-30T17:10:00+03:00'),
      reminderSettings,
    );

    expect(events).toContainEqual({ period: buildTimesheetApprovalPeriod(2026, 4, 'H1'), stage: 'deadline_morning' });
    expect(events).toContainEqual({ period: buildTimesheetApprovalPeriod(2026, 4, 'H1'), stage: 'deadline_afternoon' });
    expect(events).toContainEqual({ period: buildTimesheetApprovalPeriod(2026, 4, 'H1'), stage: 'escalation' });
  });
});

describe('submission period lock', () => {
  it('day >= 16 → allowed = current month H1', () => {
    const today = new Date('2026-05-16T12:00:00+03:00');
    expect(getAllowedSubmissionPeriod(today)).toBe('2026-05-H1');
    expect(getAllowedSubmissionRange(today)).toEqual({ startDate: '2026-05-01', endDate: '2026-05-15' });
  });

  it('day = 15 (boundary) → allowed = previous month H2', () => {
    const today = new Date('2026-05-15T12:00:00+03:00');
    expect(getAllowedSubmissionPeriod(today)).toBe('2026-04-H2');
    expect(getAllowedSubmissionRange(today)).toEqual({ startDate: '2026-04-16', endDate: '2026-04-30' });
  });

  it('day = 1 → allowed = previous month H2 (month rollover)', () => {
    const today = new Date('2026-05-01T08:00:00+03:00');
    expect(getAllowedSubmissionPeriod(today)).toBe('2026-04-H2');
  });

  it('day = 31 → allowed = current month H1', () => {
    const today = new Date('2026-05-31T23:00:00+03:00');
    expect(getAllowedSubmissionPeriod(today)).toBe('2026-05-H1');
  });

  it('year rollover Jan → Dec of previous year', () => {
    const today = new Date('2026-01-10T12:00:00+03:00');
    expect(getAllowedSubmissionPeriod(today)).toBe('2025-12-H2');
    expect(getAllowedSubmissionRange(today)).toEqual({ startDate: '2025-12-16', endDate: '2025-12-31' });
  });

  it('handles month-length variations for H2 endDate', () => {
    // Feb non-leap 2026 → 28
    expect(getAllowedSubmissionRange(new Date('2026-03-05T12:00:00+03:00'))).toEqual({
      startDate: '2026-02-16',
      endDate: '2026-02-28',
    });
    // Feb leap 2028 → 29
    expect(getAllowedSubmissionRange(new Date('2028-03-10T12:00:00+03:00'))).toEqual({
      startDate: '2028-02-16',
      endDate: '2028-02-29',
    });
    // April → 30
    expect(getAllowedSubmissionRange(new Date('2026-05-10T12:00:00+03:00'))).toEqual({
      startDate: '2026-04-16',
      endDate: '2026-04-30',
    });
  });

  it('isRangeSubmittable accepts only the exact allowed half', () => {
    // today 2026-05-19 (H2) → allowed = 2026-05-H1 = 01..15
    const today = new Date('2026-05-19T12:00:00+03:00');
    expect(isRangeSubmittable('2026-05-01', '2026-05-15', today)).toBe(true);
    // older half
    expect(isRangeSubmittable('2026-04-16', '2026-04-30', today)).toBe(false);
    // current in-progress half
    expect(isRangeSubmittable('2026-05-16', '2026-05-31', today)).toBe(false);
    // future half
    expect(isRangeSubmittable('2026-06-01', '2026-06-15', today)).toBe(false);
    // FULL month
    expect(isRangeSubmittable('2026-05-01', '2026-05-31', today)).toBe(false);
    // custom range
    expect(isRangeSubmittable('2026-05-05', '2026-05-20', today)).toBe(false);
  });

  it('flips H1/H2 by Moscow calendar day around midnight', () => {
    expect(getAllowedSubmissionPeriod(new Date('2026-05-15T23:59:00+03:00'))).toBe('2026-04-H2');
    expect(getAllowedSubmissionPeriod(new Date('2026-05-16T00:01:00+03:00'))).toBe('2026-05-H1');
  });
});
