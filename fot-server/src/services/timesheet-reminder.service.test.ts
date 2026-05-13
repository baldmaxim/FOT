import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedState = vi.hoisted(() => ({
  listTimesheetWorkflowRecipientIds: vi.fn(async () => ['user-1']),
  listUserIdsAssignedToDepartment: vi.fn(async () => [] as string[]),
}));

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

vi.mock('./notification.service.js', () => ({
  notificationService: {
    createMany: vi.fn(async () => undefined),
  },
}));

vi.mock('./push.service.js', () => ({
  pushService: {
    sendGenericNotification: vi.fn(async () => undefined),
  },
}));

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getTimesheetReminderConfig: vi.fn(async () => ({
      enabled: true,
      timezone: 'Europe/Moscow',
      openingReminderHour: 9,
      deadlineMorningHour: 10,
      deadlineAfternoonHour: 16,
      escalationHour: 17,
      overdueHour: 9,
    })),
  },
}));

vi.mock('./timesheet-period.service.js', () => ({
  formatTimesheetHalfLabel: vi.fn(() => '1-15'),
  getTimesheetReminderEventsForDate: vi.fn(() => []),
  parseTimesheetApprovalPeriod: vi.fn(() => null),
}));

vi.mock('./timesheet-workflow-recipients.service.js', () => ({
  listTimesheetWorkflowRecipientIds: mockedState.listTimesheetWorkflowRecipientIds,
}));

vi.mock('./department-access.service.js', () => ({
  listUserIdsAssignedToDepartment: mockedState.listUserIdsAssignedToDepartment,
}));

import { listTimesheetReminderRecipientIds } from './timesheet-reminder.service.js';

describe('timesheet-reminder.service', () => {
  beforeEach(() => {
    mockedState.listTimesheetWorkflowRecipientIds.mockClear();
    mockedState.listTimesheetWorkflowRecipientIds.mockResolvedValue(['user-1']);
    mockedState.listUserIdsAssignedToDepartment.mockClear();
    mockedState.listUserIdsAssignedToDepartment.mockResolvedValue([]);
  });

  it('uses submit recipients for filing reminders and excludes admin roles', async () => {
    const recipients = await listTimesheetReminderRecipientIds('dept-a', 'deadline_morning');

    expect(recipients).toEqual(['user-1']);
    expect(mockedState.listTimesheetWorkflowRecipientIds).toHaveBeenCalledWith(
      'dept-a',
      ['submit'],
      {
        excludeRoleCodes: ['admin', 'super_admin'],
      },
    );
  });

  it('uses department submit recipients for overdue reminders too', async () => {
    const recipients = await listTimesheetReminderRecipientIds('dept-a', 'overdue');

    expect(recipients).toEqual(['user-1']);
    expect(mockedState.listTimesheetWorkflowRecipientIds).toHaveBeenCalledWith(
      'dept-a',
      ['submit'],
      {
        excludeRoleCodes: ['admin', 'super_admin'],
      },
    );
  });

  it('unions workflow recipients with users assigned via employee_department_access and dedupes', async () => {
    mockedState.listTimesheetWorkflowRecipientIds.mockResolvedValueOnce(['user-1', 'user-2']);
    mockedState.listUserIdsAssignedToDepartment.mockResolvedValueOnce(['user-2', 'user-3']);

    const recipients = await listTimesheetReminderRecipientIds('dept-a', 'deadline_morning');

    expect(recipients.sort()).toEqual(['user-1', 'user-2', 'user-3']);
    expect(mockedState.listUserIdsAssignedToDepartment).toHaveBeenCalledWith('dept-a');
  });
});
