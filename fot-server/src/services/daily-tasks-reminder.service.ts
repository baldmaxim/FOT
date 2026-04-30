import { supabase } from '../config/database.js';
import { notificationService } from './notification.service.js';
import { pushService } from './push.service.js';

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
  const { data, error } = await supabase
    .from('role_page_access')
    .select('role_code')
    .eq('page_path', '/employee/tasks')
    .eq('can_view', true);

  if (error) throw error;
  return new Set((data || []).map(r => r.role_code as string));
};

interface ICandidate {
  user_id: string;
  employee_id: number;
}

const loadCandidates = async (allowedRoleCodes: Set<string>): Promise<ICandidate[]> => {
  if (allowedRoleCodes.size === 0) return [];

  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, employee_id, system_roles!inner(code)')
    .not('employee_id', 'is', null)
    .eq('is_approved', true);

  if (error) throw error;

  const profiles = (data || []) as Array<{
    id: string;
    employee_id: number;
    system_roles: { code: string } | { code: string }[] | null;
  }>;

  const filtered: ICandidate[] = [];
  for (const profile of profiles) {
    const role = Array.isArray(profile.system_roles)
      ? profile.system_roles[0]
      : profile.system_roles;
    if (!role || !allowedRoleCodes.has(role.code)) continue;
    if (profile.employee_id == null) continue;
    filtered.push({ user_id: profile.id, employee_id: profile.employee_id });
  }

  if (filtered.length === 0) return [];

  // Оставляем только активных сотрудников
  const employeeIds = filtered.map(c => c.employee_id);
  const { data: employees, error: empErr } = await supabase
    .from('employees')
    .select('id, employment_status')
    .in('id', employeeIds)
    .eq('employment_status', 'active');

  if (empErr) throw empErr;
  const activeIds = new Set((employees || []).map(e => e.id as number));
  return filtered.filter(c => activeIds.has(c.employee_id));
};

const loadEmployeesWithFilledToday = async (
  employeeIds: number[],
  taskDate: string,
): Promise<Set<number>> => {
  if (employeeIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from('daily_tasks')
    .select('employee_id')
    .eq('task_date', taskDate)
    .in('employee_id', employeeIds);

  if (error) throw error;
  return new Set((data || []).map(r => r.employee_id as number));
};

const reserveRemindersInLog = async (
  candidates: ICandidate[],
  reminderDate: string,
): Promise<ICandidate[]> => {
  if (candidates.length === 0) return [];

  const rows = candidates.map(c => ({
    employee_id: c.employee_id,
    reminder_date: reminderDate,
  }));

  // ON CONFLICT DO NOTHING + RETURNING — Supabase возвращает только реально вставленные
  const { data, error } = await supabase
    .from('daily_tasks_reminder_log')
    .upsert(rows, { onConflict: 'employee_id,reminder_date', ignoreDuplicates: true })
    .select('employee_id');

  if (error) throw error;
  const inserted = new Set((data || []).map(r => r.employee_id as number));
  return candidates.filter(c => inserted.has(c.employee_id));
};

async function runReminderCycle(): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    try {
      const parts = getMoscowParts(new Date());
      if (!shouldFireNow(parts)) return;

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
      console.error('[daily-tasks-reminder] error:', error instanceof Error ? error.message : error);
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
