import { query } from '../config/postgres.js';
import { listEmployeeIdsAssignedToDepartmentPeriod } from './timesheet-department-assignments.service.js';
import { getOffDatesByEmployee } from './timesheet-approval-weekend-check.service.js';
import { resolveSchedulesForPeriod, loadCalendarMonth } from './schedule.service.js';
import { listNonHolidayWeekendDays } from '../controllers/timesheet.controller.js';
import type { ITimesheetDateRange } from './timesheet-range.service.js';

const ATTACHMENT_REQUIRED_LEAVE_TYPES = ['vacation'] as const;

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
  vacation: 'Отпуск',
};

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

export type ICorrectionValidationScope =
  | { kind: 'department'; departmentId: string }
  | { kind: 'personal'; employeeIds: number[] };

type WeekendDow = 0 | 6; // 0 = воскресенье, 6 = суббота

/**
 * Освобождает от требования корректировки первые `expected_{saturdays|sundays}_per_month`
 * отработанных непраздничных Сб/Вс месяца БЕЗ корректировки. Корректировка — пометка
 * «лишнего» (сверх нормы) выходного, поэтому на обязательные слоты претендуют только дни
 * без корректировки; дни с корректировкой не флагуются и слоты не занимают.
 *
 * Группировка по (employee, год-месяц, dow). Праздничные Сб/Вс (mandatory_holidays всегда,
 * holidays при respects_holidays) в кандидаты не попадают — такой день всегда требует
 * корректировку. Доп. запросов к БД нет: используем уже загруженные weekendSkudRows и
 * множество корректировок adjustmentByEmployeeDate.
 */
async function computeMandatoryExemptions(
  weekendSkudRows: Array<{ employee_id: number; date: string }>,
  adjustmentByEmployeeDate: Set<string>,
): Promise<Set<string>> {
  if (weekendSkudRows.length === 0) return new Set();

  const employeeIds = [...new Set(weekendSkudRows.map(r => r.employee_id))];
  const exemptions = new Set<string>();

  const allDates = weekendSkudRows.map(r => r.date).sort();
  const schedules = await resolveSchedulesForPeriod(
    employeeIds.map(id => ({ id })),
    allDates[0]!,
    allDates[allDates.length - 1]!,
  );

  // Группируем СКУД-выходные по (employee, год-месяц, dow)
  const groups = new Map<string, { empId: number; year: number; month: number; dow: WeekendDow; dates: string[] }>();
  for (const row of weekendSkudRows) {
    const { employee_id: empId, date } = row;
    const dateObj = new Date(`${date}T00:00:00`);
    const dow = dateObj.getDay();
    if (dow !== 0 && dow !== 6) continue;
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1;
    const key = `${empId}|${year}-${month}|${dow}`;
    let group = groups.get(key);
    if (!group) {
      group = { empId, year, month, dow: dow as WeekendDow, dates: [] };
      groups.set(key, group);
    }
    group.dates.push(date);
  }

  const calendarCache = new Map<string, Awaited<ReturnType<typeof loadCalendarMonth>>>();
  const getCalendar = async (year: number, month: number) => {
    const ckey = `${year}-${month}`;
    if (!calendarCache.has(ckey)) {
      calendarCache.set(ckey, await loadCalendarMonth(year, month));
    }
    return calendarCache.get(ckey) ?? null;
  };

  for (const group of groups.values()) {
    const { empId, year, month, dow, dates } = group;
    // Любой день группы даёт нужные атрибуты графика (стабильны в пределах месяца)
    const dailySchedule = schedules.get(empId)?.get(dates[0]!);
    if (!dailySchedule) continue;

    const expected = dow === 6
      ? (dailySchedule.expected_saturdays_per_month ?? 0)
      : (dailySchedule.expected_sundays_per_month ?? 0);
    if (expected <= 0) continue;

    const monthCalendar = await getCalendar(year, month);
    const validDays = new Set(listNonHolidayWeekendDays(
      year,
      month,
      monthCalendar,
      dailySchedule.respects_holidays ?? true,
      dow,
    ));

    // Кандидаты на обязательный слот: непраздничные выходные без корректировки
    const candidates = [...new Set(dates)]
      .filter(date => validDays.has(date) && !adjustmentByEmployeeDate.has(`${empId}|${date}`))
      .sort();

    for (const date of candidates.slice(0, expected)) {
      exemptions.add(`${empId}|${date}`);
    }
  }

  return exemptions;
}

/**
 * Подача табеля блокируется в двух случаях:
 * 1) есть approved leave_requests типа remote/vacation без файла-подтверждения;
 * 2) есть работа в выходной по СКУД, для которой не создана корректировка.
 *
 * Pending-корректировки выходных подачу НЕ блокируют — они отображаются
 * на странице «Табели на согласовании» как несогласованные (синий ярлык),
 * а блокировку даёт уже шаг утверждения табеля админом.
 *
 * Исключение: СКУД-активность в первые N обязательных суббот/воскресений
 * (expected_saturdays_per_month / expected_sundays_per_month) без корректировки
 * НЕ блокирует подачу.
 */
export async function validateCorrectionAttachments(
  scope: ICorrectionValidationScope,
  range: ITimesheetDateRange,
): Promise<ICorrectionValidationResult> {
  const employeeIds = scope.kind === 'department'
    ? await listEmployeeIdsAssignedToDepartmentPeriod(
        scope.departmentId,
        range.startDate,
        range.endDate,
      )
    : [...new Set(scope.employeeIds)].filter((id): id is number => Number.isInteger(id) && id > 0);
  if (employeeIds.length === 0) {
    return { ok: true };
  }

  const adjustments = await query<IAdjustmentDateRow>(
    `SELECT employee_id, work_date
       FROM attendance_adjustments
      WHERE employee_id = ANY($1::int[])
        AND work_date >= $2
        AND work_date <= $3`,
    [employeeIds, range.startDate, range.endDate],
  );

  const leaves = await query<ILeaveRow>(
    `SELECT id, employee_id, request_type, start_date, end_date, correction_date
       FROM leave_requests
      WHERE employee_id = ANY($1::int[])
        AND status = 'approved'
        AND request_type = ANY($2::text[])
        AND start_date <= $3
        AND end_date >= $4`,
    [employeeIds, [...ATTACHMENT_REQUIRED_LEAVE_TYPES], range.endDate, range.startDate],
  );

  const leaveIdSet = new Set(leaves.map(l => String(l.id)));
  const linkedLeaveIds = new Set<string>();

  if (leaveIdSet.size > 0) {
    const linkRows = await query<{ entity_id: string }>(
      `SELECT entity_id
         FROM document_links
        WHERE entity_type = 'leave_request'
          AND entity_id = ANY($1::text[])`,
      [[...leaveIdSet]],
    );
    for (const row of linkRows) {
      linkedLeaveIds.add(String(row.entity_id));
    }
  }

  const offByEmployee = await getOffDatesByEmployee(employeeIds, range.startDate, range.endDate);
  const adjustmentByEmployeeDate = new Set<string>();
  for (const adj of adjustments) {
    adjustmentByEmployeeDate.add(`${adj.employee_id}|${adj.work_date}`);
  }

  let anyOff = false;
  for (const set of offByEmployee.values()) {
    if (set.size > 0) { anyOff = true; break; }
  }

  let weekendSkudRows: Array<{ employee_id: number; date: string }> = [];
  if (anyOff) {
    const skudRows = await query<{ employee_id: number; date: string; total_minutes: number }>(
      `SELECT employee_id, date::text AS date, total_minutes
         FROM skud_daily_summary
        WHERE employee_id = ANY($1::int[])
          AND date >= $2::date
          AND date <= $3::date
          AND total_minutes > 0
        ORDER BY date ASC`,
      [employeeIds, range.startDate, range.endDate],
    );
    weekendSkudRows = skudRows
      .map(row => ({
        employee_id: Number(row.employee_id),
        date: String(row.date).slice(0, 10),
      }))
      .filter(row => offByEmployee.get(row.employee_id)?.has(row.date) === true);
  }

  const mandatoryExemptions = await computeMandatoryExemptions(weekendSkudRows, adjustmentByEmployeeDate);

  const referencedEmployeeIds = new Set<number>();
  for (const lr of leaves) referencedEmployeeIds.add(lr.employee_id);
  for (const row of weekendSkudRows) referencedEmployeeIds.add(row.employee_id);

  let nameMap = new Map<number, string | null>();
  if (referencedEmployeeIds.size > 0) {
    const empRows = await query<{ id: number; full_name: string | null }>(
      'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
      [[...referencedEmployeeIds]],
    );
    nameMap = new Map(empRows.map(row => [Number(row.id), row.full_name ?? null]));
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
    if (mandatoryExemptions.has(`${row.employee_id}|${row.date}`)) continue;
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
