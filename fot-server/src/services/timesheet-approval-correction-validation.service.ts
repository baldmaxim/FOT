import { supabase } from '../config/database.js';
import { listEmployeeIdsAssignedToDepartmentPeriod } from './timesheet-department-assignments.service.js';
import { loadCalendarMonth } from './schedule.service.js';
import type { ITimesheetDateRange } from './timesheet-range.service.js';

const ATTACHMENT_REQUIRED_LEAVE_TYPES = ['remote', 'vacation'] as const;

export type MissingDayKind = 'leave_request' | 'weekend_no_correction';

export interface IMissingDay {
  date: string;
  employee_id: number;
  employee_name: string | null;
  kind: MissingDayKind;
  reason: string;
}

export type ICorrectionValidationResult =
  | { ok: true }
  | { ok: false; missing: IMissingDay[] };

const LEAVE_TYPE_LABELS_RU: Record<string, string> = {
  remote: 'Удалёнка',
  vacation: 'Отпуск',
};

const iterateDates = (startDate: string, endDate: string, cb: (iso: string) => void): void => {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const cursor = new Date(start);
  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    cb(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
};

async function collectWeekendDates(startDate: string, endDate: string): Promise<Set<string>> {
  const weekends = new Set<string>();
  const months = new Set<string>();
  iterateDates(startDate, endDate, (iso) => {
    months.add(iso.slice(0, 7));
    const d = new Date(`${iso}T00:00:00`);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) weekends.add(iso);
  });

  for (const ym of months) {
    const [y, m] = ym.split('-').map(Number);
    const calendar = await loadCalendarMonth(y, m);
    if (!calendar) continue;
    for (const holiday of calendar.holidays ?? []) {
      if (typeof holiday === 'string' && holiday >= startDate && holiday <= endDate) {
        weekends.add(holiday);
      }
    }
    for (const holiday of calendar.mandatory_holidays ?? []) {
      if (typeof holiday === 'string' && holiday >= startDate && holiday <= endDate) {
        weekends.add(holiday);
      }
    }
  }
  return weekends;
}

interface IAdjustmentDateRow {
  employee_id: number;
  work_date: string;
}

interface ILeaveRow {
  id: number;
  employee_id: number;
  request_type: string;
  start_date: string;
  end_date: string;
  correction_date: string | null;
}

/**
 * Подача табеля блокируется в двух случаях:
 * 1) есть approved leave_requests типа remote/vacation без файла-подтверждения;
 * 2) есть работа в выходной по СКУД, для которой не создана корректировка.
 *
 * Pending-корректировки выходных подачу НЕ блокируют — они отображаются
 * на странице «Табели на согласовании» как несогласованные (синий ярлык),
 * а блокировку даёт уже шаг утверждения табеля админом.
 */
export async function validateCorrectionAttachments(
  departmentId: string,
  range: ITimesheetDateRange,
): Promise<ICorrectionValidationResult> {
  const employeeIds = await listEmployeeIdsAssignedToDepartmentPeriod(
    departmentId,
    range.startDate,
    range.endDate,
  );
  if (employeeIds.length === 0) {
    return { ok: true };
  }

  const adjRes = await supabase
    .from('attendance_adjustments')
    .select('employee_id, work_date')
    .in('employee_id', employeeIds)
    .gte('work_date', range.startDate)
    .lte('work_date', range.endDate);
  if (adjRes.error) throw adjRes.error;
  const adjustments = (adjRes.data || []) as IAdjustmentDateRow[];

  const leaveRes = await supabase
    .from('leave_requests')
    .select('id, employee_id, request_type, start_date, end_date, correction_date')
    .in('employee_id', employeeIds)
    .eq('status', 'approved')
    .in('request_type', [...ATTACHMENT_REQUIRED_LEAVE_TYPES])
    .lte('start_date', range.endDate)
    .gte('end_date', range.startDate);
  if (leaveRes.error) throw leaveRes.error;
  const leaves = (leaveRes.data || []) as ILeaveRow[];

  const leaveIdSet = new Set(leaves.map(l => String(l.id)));
  const linkedLeaveIds = new Set<string>();

  if (leaveIdSet.size > 0) {
    const linkRes = await supabase
      .from('document_links')
      .select('entity_id')
      .eq('entity_type', 'leave_request')
      .in('entity_id', [...leaveIdSet]);
    if (linkRes.error) throw linkRes.error;
    for (const row of linkRes.data || []) {
      linkedLeaveIds.add(String(row.entity_id));
    }
  }

  const weekendDates = await collectWeekendDates(range.startDate, range.endDate);
  const adjustmentByEmployeeDate = new Set<string>();
  for (const adj of adjustments) {
    adjustmentByEmployeeDate.add(`${adj.employee_id}|${adj.work_date}`);
  }

  let weekendSkudRows: Array<{ employee_id: number; date: string }> = [];
  if (weekendDates.size > 0) {
    const skudRes = await supabase
      .from('skud_daily_summary')
      .select('employee_id, date, total_minutes')
      .in('employee_id', employeeIds)
      .in('date', [...weekendDates])
      .gt('total_minutes', 0);
    if (skudRes.error) throw skudRes.error;
    weekendSkudRows = (skudRes.data || []).map(row => ({
      employee_id: Number(row.employee_id),
      date: String(row.date),
    }));
  }

  const referencedEmployeeIds = new Set<number>();
  for (const lr of leaves) referencedEmployeeIds.add(lr.employee_id);
  for (const row of weekendSkudRows) referencedEmployeeIds.add(row.employee_id);

  let nameMap = new Map<number, string | null>();
  if (referencedEmployeeIds.size > 0) {
    const empRes = await supabase
      .from('employees')
      .select('id, full_name')
      .in('id', [...referencedEmployeeIds]);
    if (empRes.error) throw empRes.error;
    nameMap = new Map((empRes.data || []).map(row => [Number(row.id), (row.full_name as string | null) ?? null]));
  }

  const missing: IMissingDay[] = [];

  for (const lr of leaves) {
    if (linkedLeaveIds.has(String(lr.id))) continue;
    const typeLabel = LEAVE_TYPE_LABELS_RU[lr.request_type] ?? lr.request_type;
    const refDate = lr.correction_date ?? lr.start_date;
    missing.push({
      date: refDate,
      employee_id: lr.employee_id,
      employee_name: nameMap.get(lr.employee_id) ?? null,
      kind: 'leave_request',
      reason: `Заявление «${typeLabel}» без файла-подтверждения`,
    });
  }

  for (const row of weekendSkudRows) {
    if (adjustmentByEmployeeDate.has(`${row.employee_id}|${row.date}`)) continue;
    missing.push({
      date: row.date,
      employee_id: row.employee_id,
      employee_name: nameMap.get(row.employee_id) ?? null,
      kind: 'weekend_no_correction',
      reason: 'Работа в выходной без корректировки — создайте корректировку',
    });
  }

  if (missing.length === 0) {
    return { ok: true };
  }

  missing.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const nameA = a.employee_name ?? '';
    const nameB = b.employee_name ?? '';
    return nameA.localeCompare(nameB, 'ru');
  });

  return { ok: false, missing };
}
