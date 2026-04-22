import { supabase } from '../config/database.js';
import { notificationService } from './notification.service.js';
import { pushService } from './push.service.js';
import { settingsService } from './settings.service.js';
import {
  formatTimesheetHalfLabel,
  getTimesheetReminderEventsForDate,
  type ITimesheetReminderEvent,
  parseTimesheetApprovalPeriod,
} from './timesheet-period.service.js';
import { listTimesheetWorkflowRecipientIds } from './timesheet-workflow-recipients.service.js';
import { listUserIdsAssignedToDepartment } from './department-access.service.js';

const REMINDER_INTERVAL_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 45_000;
const REMINDER_EXCLUDED_ROLE_CODES = ['admin', 'super_admin'] as const;

let reminderTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;

function getTimesheetPath(period: string, stage: string): string {
  const parsed = parseTimesheetApprovalPeriod(period);
  if (!parsed) return '/timesheet';
  return `/timesheet?month=${parsed.year}-${String(parsed.month).padStart(2, '0')}&half=${parsed.half}&stage=${stage}`;
}

function buildDepartmentReminderMessage(period: string, departmentName: string, stage: string): { title: string; body: string } {
  const parsed = parseTimesheetApprovalPeriod(period);
  if (!parsed) {
    return {
      title: 'Нужно подать табель',
      body: `Не забудьте подать табель по отделу ${departmentName}.`,
    };
  }

  const periodLabel = formatTimesheetHalfLabel(parsed.half, parsed.year, parsed.month);
  if (stage === 'opening') {
    return {
      title: 'Открылся период подачи табеля',
      body: `Отдел ${departmentName}: открылся период ${periodLabel}. Проверьте и подайте табель вовремя.`,
    };
  }

  if (stage === 'escalation') {
    return {
      title: 'Срочно: табель не подан',
      body: `Отдел ${departmentName}: табель за период ${periodLabel} всё ещё не подан. Нужна подача сегодня.`,
    };
  }

  return {
    title: 'Напоминание о подаче табеля',
    body: `Отдел ${departmentName}: нужно подать табель за период ${periodLabel}.`,
  };
}

function buildHrReminderMessage(period: string, departmentName: string): { title: string; body: string } {
  const parsed = parseTimesheetApprovalPeriod(period);
  if (!parsed) {
    return {
      title: 'Просрочка подачи табеля',
      body: `Отдел ${departmentName}: срок подачи табеля прошёл, но табель не подан.`,
    };
  }

  const periodLabel = formatTimesheetHalfLabel(parsed.half, parsed.year, parsed.month);
  return {
    title: 'Просрочка подачи табеля',
    body: `Отдел ${departmentName}: табель за период ${periodLabel} не подан в срок.`,
  };
}

async function loadActiveDepartmentIds(): Promise<string[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('org_department_id')
    .eq('employment_status', 'active')
    .eq('is_archived', false)
    .eq('excluded_from_timesheet', false)
    .not('org_department_id', 'is', null);

  if (error) {
    throw error;
  }

  return [...new Set((data || []).map(item => item.org_department_id as string).filter(Boolean))];
}

async function loadDepartmentNameMap(departmentIds: string[]): Promise<Map<string, string>> {
  if (departmentIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('org_departments')
    .select('id, name')
    .in('id', departmentIds);

  if (error) {
    throw error;
  }

  return new Map((data || []).map(item => [item.id as string, (item.name as string) || item.id]));
}

async function loadApprovalStatusMap(period: string, departmentIds: string[]): Promise<Map<string, string>> {
  if (departmentIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('timesheet_approvals')
    .select('department_id, status')
    .eq('period', period)
    .in('department_id', departmentIds);

  if (error) {
    throw error;
  }

  return new Map((data || []).map(item => [item.department_id as string, item.status as string]));
}

async function hasReminderLog(departmentId: string, period: string, userId: string, stage: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('timesheet_reminder_log')
    .select('id')
    .eq('department_id', departmentId)
    .eq('period', period)
    .eq('user_id', userId)
    .eq('stage', stage)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return !!data;
}

async function persistReminderLog(items: Array<{
  department_id: string;
  period: string;
  user_id: string;
  stage: string;
  metadata: Record<string, unknown>;
}>): Promise<void> {
  if (items.length === 0) return;

  const { error } = await supabase
    .from('timesheet_reminder_log')
    .upsert(items, { onConflict: 'department_id,period,user_id,stage' });

  if (error) {
    throw error;
  }
}

export async function listTimesheetReminderRecipientIds(
  departmentId: string,
  _stage: ITimesheetReminderEvent['stage'],
): Promise<string[]> {
  const [workflowIds, assignedIds] = await Promise.all([
    listTimesheetWorkflowRecipientIds(
      departmentId,
      ['submit'],
      {
        excludeRoleCodes: [...REMINDER_EXCLUDED_ROLE_CODES],
      },
    ),
    listUserIdsAssignedToDepartment(departmentId),
  ]);

  return [...new Set([...workflowIds, ...assignedIds])];
}

async function processReminderEvent(event: ITimesheetReminderEvent): Promise<void> {
  const departmentIds = await loadActiveDepartmentIds();
  if (departmentIds.length === 0) return;

  const [departmentNameMap, approvalStatusMap] = await Promise.all([
    loadDepartmentNameMap(departmentIds),
    loadApprovalStatusMap(event.period, departmentIds),
  ]);

  for (const departmentId of departmentIds) {
    const approvalStatus = approvalStatusMap.get(departmentId);
    if (approvalStatus === 'submitted' || approvalStatus === 'approved') {
      continue;
    }

    const departmentName = departmentNameMap.get(departmentId) || departmentId;
    let recipientIds: string[] = [];
    let title = '';
    let body = '';
    let path = getTimesheetPath(event.period, event.stage);
    let type = 'timesheet_reminder';

    if (event.stage === 'overdue') {
      recipientIds = await listTimesheetReminderRecipientIds(departmentId, 'overdue');
      ({ title, body } = buildHrReminderMessage(event.period, departmentName));
      type = 'timesheet_overdue';
    } else {
      ({ title, body } = buildDepartmentReminderMessage(event.period, departmentName, event.stage));
      recipientIds = await listTimesheetReminderRecipientIds(departmentId, event.stage);
    }

    if (recipientIds.length === 0) continue;

    const unsentRecipients: string[] = [];
    for (const userId of recipientIds) {
      if (!(await hasReminderLog(departmentId, event.period, userId, event.stage))) {
        unsentRecipients.push(userId);
      }
    }

    if (unsentRecipients.length === 0) {
      continue;
    }

    await notificationService.createMany(unsentRecipients.map(userId => ({
      userId,
      type,
      title,
      body,
      metadata: {
        departmentId,
        period: event.period,
        stage: event.stage,
        path,
      },
    })));
    await pushService.sendGenericNotification(unsentRecipients, title, body, { path, period: event.period, stage: event.stage });
    await persistReminderLog(unsentRecipients.map(userId => ({
      department_id: departmentId,
      period: event.period,
      user_id: userId,
      stage: event.stage,
      metadata: { type, path },
    })));
  }
}

async function runReminderCycle(): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    try {
      const settings = await settingsService.getTimesheetReminderConfig();
      if (!settings.enabled) return;

      const events = getTimesheetReminderEventsForDate(new Date(), settings);
      for (const event of events) {
        await processReminderEvent(event);
      }
    } catch (error) {
      console.error('[timesheet-reminder] error:', error instanceof Error ? error.message : error);
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

export function startTimesheetReminderScheduler(): void {
  if (reminderTimer || startupTimeout) return;

  console.log('[timesheet-reminder] started (interval: 15m)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runReminderCycle();
  }, STARTUP_DELAY_MS);

  reminderTimer = setInterval(() => {
    void runReminderCycle();
  }, REMINDER_INTERVAL_MS);
}

export function stopTimesheetReminderScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }

  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
    console.log('[timesheet-reminder] stopped');
  }
}

export const __private__ = {
  buildDepartmentReminderMessage,
  buildHrReminderMessage,
  getTimesheetPath,
};
