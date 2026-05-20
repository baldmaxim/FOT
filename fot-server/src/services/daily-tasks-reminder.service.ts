import { query } from '../config/postgres.js';
import { notificationService } from './notification.service.js';
import { pushService } from './push.service.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

const REMINDER_INTERVAL_MS = 5 * 60_000; // 5 минут
const STARTUP_DELAY_MS = 60_000;         // минута после старта
const REMINDER_TZ = 'Europe/Moscow';
const REMINDER_HOUR = 16;
const REMINDER_MINUTE_FROM = 50; // окно [16:50; 17:00)
const REMINDER_MINUTE_TO = 60;

let reminderTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;

interface IMoscowParts {
  hour: number;
  minute: number;
  weekday: number; // 1=Mon ... 7=Sun
  dateIso: string;
}

const getMoscowParts = (now: Date): IMoscowParts => {
  const dateIso = new Intl.DateTimeFormat('en-CA', {
    timeZone: REMINDER_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);

  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: REMINDER_TZ, hour: '2-digit', hour12: false,
  }).format(now);
  const minuteStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: REMINDER_TZ, minute: '2-digit',
  }).format(now);

  // Intl weekday: 'short' returns Mon..Sun; map к 1..7
  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone: REMINDER_TZ, weekday: 'short',
  }).format(now);
  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };

  return {
    hour: parseInt(hourStr, 10),
    minute: parseInt(minuteStr, 10),
    weekday: weekdayMap[weekdayShort] ?? 0,
    dateIso,
  };
};

const shouldFireNow = (parts: IMoscowParts): boolean => {
  if (parts.weekday >= 6) return false; // выходные
  if (parts.hour !== REMINDER_HOUR) return false;
  return parts.minute >= REMINDER_MINUTE_FROM && parts.minute < REMINDER_MINUTE_TO;
};

const loadAllowedRoleCodes = async (): Promise<Set<string>> => {
  const rows = await query<{ role_code: string }>(
    `SELECT role_code FROM role_page_access
      WHERE page_path = '/employee/tasks' AND can_view = true`,
  );
  return new Set(rows.map(r => r.role_code));
};

interface ICandidate {
  user_id: string;
  employee_id: number;
}

const loadCandidates = async (allowedRoleCodes: Set<string>): Promise<ICandidate[]> => {
  if (allowedRoleCodes.size === 0) return [];

  const profiles = await query<{
    id: string;
    employee_id: number | null;
    role_code: string | null;
  }>(
    `SELECT up.id, up.employee_id, sr.code AS role_code
       FROM user_profiles up
       JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE up.employee_id IS NOT NULL AND up.is_approved = true`,
  );

  const filtered: ICandidate[] = [];
  for (const profile of profiles) {
    if (!profile.role_code || !allowedRoleCodes.has(profile.role_code)) continue;
    if (profile.employee_id == null) continue;
    filtered.push({ user_id: profile.id, employee_id: profile.employee_id });
  }

  if (filtered.length === 0) return [];

  // Оставляем только активных сотрудников
  const employeeIds = filtered.map(c => c.employee_id);
  const employees = await query<{ id: number }>(
    `SELECT id FROM employees
      WHERE id = ANY($1::bigint[]) AND employment_status = 'active'`,
    [employeeIds],
  );
  const activeIds = new Set(employees.map(e => e.id));
  return filtered.filter(c => activeIds.has(c.employee_id));
};

const loadEmployeesWithFilledToday = async (
  employeeIds: number[],
  taskDate: string,
): Promise<Set<number>> => {
  if (employeeIds.length === 0) return new Set();

  const rows = await query<{ employee_id: number }>(
    `SELECT employee_id FROM daily_tasks
      WHERE task_date = $1 AND employee_id = ANY($2::bigint[])`,
    [taskDate, employeeIds],
  );
  return new Set(rows.map(r => r.employee_id));
};

const reserveRemindersInLog = async (
  candidates: ICandidate[],
  reminderDate: string,
): Promise<ICandidate[]> => {
  if (candidates.length === 0) return [];

  const empIds = candidates.map(c => c.employee_id);

  // ON CONFLICT DO NOTHING + RETURNING — возвращает только реально вставленные
  const inserted = await query<{ employee_id: number }>(
    `INSERT INTO daily_tasks_reminder_log (employee_id, reminder_date)
     SELECT u.employee_id, $2::date
       FROM unnest($1::bigint[]) AS u(employee_id)
     ON CONFLICT (employee_id, reminder_date) DO NOTHING
     RETURNING employee_id`,
    [empIds, reminderDate],
  );
  const insertedSet = new Set(inserted.map(r => r.employee_id));
  return candidates.filter(c => insertedSet.has(c.employee_id));
};

async function runReminderCycle(): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    try {
      const parts = getMoscowParts(new Date());
      // Cron-чек-ин шлём только в активном окне 16:50–17:00 МСК будни.
      // Иначе 5-минутный тик флудил бы Sentry "ok" каждые 5 минут впустую.
      if (!shouldFireNow(parts)) return;

      let cronStatus: CronRunStatus = 'ok';
      await runWithCronMonitor(
        'daily-tasks-reminder',
        async () => {
          try {
            const allowedRoleCodes = await loadAllowedRoleCodes();
            const candidates = await loadCandidates(allowedRoleCodes);
            if (candidates.length === 0) return;

            const filledToday = await loadEmployeesWithFilledToday(
              candidates.map(c => c.employee_id),
              parts.dateIso,
            );
            const pending = candidates.filter(c => !filledToday.has(c.employee_id));
            if (pending.length === 0) return;

            const fresh = await reserveRemindersInLog(pending, parts.dateIso);
            if (fresh.length === 0) return;

            const userIds = fresh.map(c => c.user_id);
            const title = 'Запишите задачи за день';
            const body = 'Не забудьте заполнить, что сделали сегодня. После полуночи запись закроется.';
            const path = '/employee';

            await notificationService.createMany(userIds.map(userId => ({
              userId,
              type: 'daily_tasks_reminder',
              title,
              body,
              metadata: { path, reminderDate: parts.dateIso },
            })));

            await pushService.sendGenericNotification(userIds, title, body, {
              path,
              reminderDate: parts.dateIso,
            });

            console.log(`[daily-tasks-reminder] sent ${fresh.length} reminders for ${parts.dateIso}`);
          } catch (error) {
            cronStatus = 'error';
            console.error('[daily-tasks-reminder] error:', error instanceof Error ? error.message : error);
          }
          return cronStatus;
        },
        {
          schedule: { type: 'crontab', value: '50 16 * * 1-5' },
          checkinMargin: 15,
          maxRuntime: 10,
        },
      );
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

export function startDailyTasksReminderScheduler(): void {
  if (reminderTimer || startupTimeout) return;

  console.log('[daily-tasks-reminder] started (interval: 5m, fires at 16:50 МСК будни)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runReminderCycle();
  }, STARTUP_DELAY_MS);

  reminderTimer = setInterval(() => {
    void runReminderCycle();
  }, REMINDER_INTERVAL_MS);
}

export function stopDailyTasksReminderScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
    console.log('[daily-tasks-reminder] stopped');
  }
}
