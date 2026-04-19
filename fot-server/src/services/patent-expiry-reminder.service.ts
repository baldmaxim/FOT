import { supabase } from '../config/database.js';
import { notificationService } from './notification.service.js';
import { pushService } from './push.service.js';

const REMINDER_INTERVAL_MS = 24 * 60 * 60_000;
const STARTUP_DELAY_MS = 60_000;
const EXPIRY_WINDOW_DAYS = 30;

let reminderTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;

interface IExpiringEmployee {
  id: number;
  full_name: string | null;
  patent_expiry_date: string;
}

function formatExpiryDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('ru-RU');
}

function daysUntil(iso: string): number {
  const now = new Date();
  const expiry = new Date(iso);
  return Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60_000));
}

async function loadExpiringEmployees(): Promise<IExpiringEmployee[]> {
  const today = new Date();
  const end = new Date(today.getTime() + EXPIRY_WINDOW_DAYS * 24 * 60 * 60_000);
  const todayIso = today.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name, patent_expiry_date')
    .eq('employment_status', 'active')
    .eq('is_archived', false)
    .not('patent_expiry_date', 'is', null)
    .gte('patent_expiry_date', todayIso)
    .lte('patent_expiry_date', endIso);

  if (error) throw error;
  return (data || []) as IExpiringEmployee[];
}

async function loadEmployeeUserIds(employeeIds: number[]): Promise<Map<number, string>> {
  if (employeeIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, employee_id')
    .in('employee_id', employeeIds);

  if (error) throw error;
  return new Map((data || []).map((row: { id: string; employee_id: number }) => [row.employee_id, row.id]));
}

async function hasReminderLog(employeeId: number, reminderDate: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('patent_expiry_reminder_log')
    .select('employee_id')
    .eq('employee_id', employeeId)
    .eq('reminder_date', reminderDate)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

async function writeReminderLog(employeeId: number, reminderDate: string): Promise<void> {
  const { error } = await supabase
    .from('patent_expiry_reminder_log')
    .upsert({ employee_id: employeeId, reminder_date: reminderDate }, { onConflict: 'employee_id,reminder_date' });

  if (error) throw error;
}

async function runReminderCycle(): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    try {
      const employees = await loadExpiringEmployees();
      if (employees.length === 0) return;

      const userIdMap = await loadEmployeeUserIds(employees.map(e => e.id));
      const reminderDate = new Date().toISOString().slice(0, 10);

      for (const emp of employees) {
        const userId = userIdMap.get(emp.id);
        if (!userId) continue;

        if (await hasReminderLog(emp.id, reminderDate)) continue;

        const daysLeft = daysUntil(emp.patent_expiry_date);
        const expiryLabel = formatExpiryDate(emp.patent_expiry_date);
        const title = 'Срок патента истекает';
        const body = daysLeft <= 0
          ? `Срок патента истекает сегодня (${expiryLabel}). Не забудьте обновить.`
          : `Срок патента истекает через ${daysLeft} дн. (${expiryLabel}). Не забудьте обновить.`;
        const path = '/employee';

        try {
          await notificationService.createMany([{
            userId,
            type: 'patent_expiry',
            title,
            body,
            metadata: { expiryDate: emp.patent_expiry_date, employeeId: emp.id, path },
          }]);
          await pushService.sendGenericNotification([userId], title, body, { path, expiryDate: emp.patent_expiry_date });
          await writeReminderLog(emp.id, reminderDate);
        } catch (e) {
          console.error('[patent-expiry] send error for employee', emp.id, e);
        }
      }
    } catch (error) {
      console.error('[patent-expiry] error:', error instanceof Error ? error.message : error);
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

export function startPatentExpiryReminderScheduler(): void {
  if (reminderTimer || startupTimeout) return;

  console.log('[patent-expiry] started (interval: 24h)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runReminderCycle();
  }, STARTUP_DELAY_MS);

  reminderTimer = setInterval(() => {
    void runReminderCycle();
  }, REMINDER_INTERVAL_MS);
}

export function stopPatentExpiryReminderScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
    console.log('[patent-expiry] stopped');
  }
}
