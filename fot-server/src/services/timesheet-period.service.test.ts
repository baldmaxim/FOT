import { describe, expect, it } from 'vitest';
import {
  buildTimesheetApprovalPeriod,
  getTimesheetReminderEventsForDate,
  parseTimesheetApprovalPeriod,
} from './timesheet-period.service.js';

describe('timesheet-period.service', () => {
  it('parses half-month approval period', () => {
    expect(parseTimesheetApprovalPeriod('2026-04-H1')).toEqual({ year: 2026, month: 4, half: 'H1' });
    expect(parseTimesheetApprovalPeriod('2026-04')).toBeNull();
  });

  it('builds opening and overdue events on the first day of month', () => {
    const events = getTimesheetReminderEventsForDate(
      new Date('2026-05-01T09:30:00+03:00'),
      {
        timezone: 'Europe/Moscow',
        openingReminderHour: 9,
        deadlineMorningHour: 10,
        deadlineAfternoonHour: 16,
        escalationHour: 17,
        overdueHour: 9,
      },
    );

    expect(events).toContainEqual({ period: '2026-05-H1', stage: 'opening' });
    expect(events).toContainEqual({ period: '2026-04-H2', stage: 'overdue' });
  });

  it('builds deadline chain for second half on last day of month', () => {
    const events = getTimesheetReminderEventsForDate(
      new Date('2026-04-30T17:10:00+03:00'),
      {
        timezone: 'Europe/Moscow',
        openingReminderHour: 9,
        deadlineMorningHour: 10,
        deadlineAfternoonHour: 16,
        escalationHour: 17,
        overdueHour: 9,
      },
    );

    expect(events).toContainEqual({ period: buildTimesheetApprovalPeriod(2026, 4, 'H2'), stage: 'deadline_morning' });
    expect(events).toContainEqual({ period: buildTimesheetApprovalPeriod(2026, 4, 'H2'), stage: 'deadline_afternoon' });
    expect(events).toContainEqual({ period: buildTimesheetApprovalPeriod(2026, 4, 'H2'), stage: 'escalation' });
  });
});
