/**
 * KPI-сводка дисциплины по сотруднику или отделу (GET /api/skud/discipline/kpi).
 *
 * Состав (только авто-метрики, см. план keen-napping-parrot):
 *  - График/СКУД  — переиспользует расчёт нарушений из skud-discipline.service
 *    (опоздания, сумма минут опозданий, ранние уходы, недоработки, отсутствия).
 *  - Больничные    — дни табеля attendance_adjustments.status='sick'
 *    (канонический источник: учитывает одобрение/дедуп/ручные правки), случаи
 *    группируются по leave_request, иначе по непрерывным сериям дат. sick_worked
 *    («работал на больничном») считается отдельно, не как нарушение.
 *  - За свой счёт  — дни attendance_adjustments.status='unpaid'; заранее vs
 *    задним числом (leave_requests.created_at), превышение 14 дней/год.
 *
 * Pending-дни (approval_status='pending') показываются отдельной строкой и НЕ
 * влияют на светофор. Общий статус = максимальная severity среди блоков.
 */
import { query } from '../config/postgres.js';
import { loadCalendarMonth } from './schedule.service.js';
import type { IDisciplineResult } from '../types/skud.types.js';

export type KpiMetric = 'attendance' | 'sick' | 'unpaid';
export type KpiSeverity = 'green' | 'yellow' | 'red';

const UNPAID_YEAR_LIMIT = 14; // дней без сохранения содержания в календарном году (внутреннее положение)

export interface IKpiAttendance {
  lateCount: number;
  lateMinutes: number;
  earlyCount: number;
  underworkCount: number;
  absenceCount: number;
  workedHours: number;
  normHours: number;
  severity: KpiSeverity;
}

export interface IKpiLeaveCase {
  startDate: string;
  endDate: string;
  days: number;
  isMonFri: boolean;
  isAfterHoliday: boolean;
  isShort: boolean;
  retroactive: boolean;
}

export interface IKpiSick {
  totalDays: number;
  caseCount: number;
  shortCaseCount: number;
  monFriCount: number;
  afterHolidayCount: number;
  workedSickDays: number;
  cases: IKpiLeaveCase[];
  severity: KpiSeverity;
}

export interface IKpiUnpaid {
  totalDays: number;
  caseCount: number;
  retroactiveCaseCount: number;
  daysThisYear: number;
  overLimit: boolean;
  cases: IKpiLeaveCase[];
  severity: KpiSeverity;
}

export interface IKpiPending {
  sickDays: number;
  unpaidDays: number;
}

export interface IDisciplineKpiRow {
  employeeId: number;
  name: string;
  department: string;
  attendance: IKpiAttendance | null;
  sick: IKpiSick | null;
  unpaid: IKpiUnpaid | null;
  pending: IKpiPending;
  severity: KpiSeverity;
}

export interface IDisciplineKpiTotals {
  employeeCount: number;
  attendance: Omit<IKpiAttendance, 'severity'> | null;
  sick: Omit<IKpiSick, 'cases' | 'severity'> | null;
  unpaid: { totalDays: number; caseCount: number; retroactiveCaseCount: number; overLimitEmployees: number } | null;
  pending: IKpiPending;
}

export interface IDisciplineKpiResult {
  scope: 'employee' | 'department';
  subject: string;
  startMonth: string;
  endMonth: string;
  metrics: KpiMetric[];
  totals: IDisciplineKpiTotals;
  rows: IDisciplineKpiRow[];
  overallSeverity: KpiSeverity;
}

// ─── Чистые помощники (экспортируются для тестов) ──────────────────────────

const SEVERITY_RANK: Record<KpiSeverity, number> = { green: 0, yellow: 1, red: 2 };

export function maxSeverity(values: KpiSeverity[]): KpiSeverity {
  let best: KpiSeverity = 'green';
  for (const v of values) if (SEVERITY_RANK[v] > SEVERITY_RANK[best]) best = v;
  return best;
}

export function severityFromLateCount(count: number): KpiSeverity {
  if (count >= 3) return 'red';
  if (count >= 1) return 'yellow';
  return 'green';
}

export function severityFromShortSick(shortCaseCount: number): KpiSeverity {
  if (shortCaseCount >= 5) return 'red';
  if (shortCaseCount >= 3) return 'yellow';
  return 'green';
}

export function severityFromUnpaidDays(daysThisYear: number): KpiSeverity {
  return daysThisYear > UNPAID_YEAR_LIMIT ? 'red' : 'green';
}

/** Минуты опоздания из строки deviation формата `+1ч 20м` / `+15 мин` / `+2ч`. */
export function parseDeviationMinutes(deviation: string): number {
  const s = deviation.replace('Отсутствие', '').trim();
  let total = 0;
  const hours = s.match(/(\d+)\s*ч/);
  if (hours) total += Number(hours[1]) * 60;
  const minLong = s.match(/(\d+)\s*мин/);
  const minShort = s.match(/(\d+)\s*м(?!ин)/);
  if (minLong) total += Number(minLong[1]);
  else if (minShort) total += Number(minShort[1]);
  return total;
}

/** ISO-дата + delta дней (UTC, без TZ-сюрпризов). */
export function addDaysISO(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** День недели ISO-даты: 0=Вс … 6=Сб (UTC). */
export function weekdayISO(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

const isMonOrFri = (iso: string): boolean => {
  const wd = weekdayISO(iso);
  return wd === 1 || wd === 5;
};

/** Первый рабочий день после праздника: шаг назад через выходные до праздника. */
export function isAfterHoliday(startISO: string, holidays: Set<string>): boolean {
  let cursor = addDaysISO(startISO, -1);
  for (let i = 0; i < 7; i += 1) {
    if (holidays.has(cursor)) return true;
    const wd = weekdayISO(cursor);
    if (wd === 0 || wd === 6) {
      cursor = addDaysISO(cursor, -1);
      continue;
    }
    return false;
  }
  return false;
}

interface LeaveDay {
  date: string;
  leaveId: string | null;
}

/**
 * Группировка дней в случаи: по leave_request (source_id), иначе по непрерывным
 * сериям дат. retroactive — только для дней с leaveId (createdDate > старт случая).
 */
export function buildLeaveCases(
  days: LeaveDay[],
  holidays: Set<string>,
  leaveMeta: Map<string, { createdDate: string; startDate: string }>,
): IKpiLeaveCase[] {
  const byLeave = new Map<string, string[]>();
  const noLeave: string[] = [];
  for (const day of days) {
    if (day.leaveId) {
      const list = byLeave.get(day.leaveId) ?? [];
      list.push(day.date);
      byLeave.set(day.leaveId, list);
    } else {
      noLeave.push(day.date);
    }
  }

  const cases: IKpiLeaveCase[] = [];

  const toCase = (dates: string[], leaveId: string | null): IKpiLeaveCase => {
    const sorted = [...new Set(dates)].sort();
    const startDate = sorted[0];
    const endDate = sorted[sorted.length - 1];
    const days = sorted.length;
    const meta = leaveId ? leaveMeta.get(leaveId) : undefined;
    return {
      startDate,
      endDate,
      days,
      isShort: days >= 3 && days <= 5,
      isMonFri: isMonOrFri(startDate) || isMonOrFri(endDate),
      isAfterHoliday: isAfterHoliday(startDate, holidays),
      retroactive: meta ? meta.createdDate > startDate : false,
    };
  };

  for (const [leaveId, dates] of byLeave) cases.push(toCase(dates, leaveId));

  // Непрерывные серии для ручных дней без заявления.
  const sortedNoLeave = [...new Set(noLeave)].sort();
  let run: string[] = [];
  for (const date of sortedNoLeave) {
    if (run.length === 0 || date === addDaysISO(run[run.length - 1], 1)) {
      run.push(date);
    } else {
      cases.push(toCase(run, null));
      run = [date];
    }
  }
  if (run.length > 0) cases.push(toCase(run, null));

  return cases.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

interface AttendanceAgg {
  lateCount: number;
  lateMinutes: number;
  earlyCount: number;
  underworkCount: number;
  absenceCount: number;
  workedHours: number;
  normHours: number;
}

/** Агрегация СКУД-нарушений по одному сотруднику из общего набора violations. */
export function aggregateAttendance(
  employeeId: number,
  discipline: IDisciplineResult,
): AttendanceAgg {
  const agg: AttendanceAgg = {
    lateCount: 0,
    lateMinutes: 0,
    earlyCount: 0,
    underworkCount: 0,
    absenceCount: 0,
    workedHours: discipline.employees[employeeId]?.worked_hours ?? 0,
    normHours: discipline.employees[employeeId]?.norm_hours ?? 0,
  };
  for (const v of discipline.violations) {
    if (v.employee_id !== employeeId) continue;
    if (v.type === 'late') {
      agg.lateCount += 1;
      agg.lateMinutes += parseDeviationMinutes(v.deviation);
    } else if (v.type === 'early') agg.earlyCount += 1;
    else if (v.type === 'underwork') agg.underworkCount += 1;
    else if (v.type === 'absence') agg.absenceCount += 1;
  }
  return agg;
}

// ─── Оркестратор ───────────────────────────────────────────────────────────

interface AdjustmentRow {
  employee_id: number;
  work_date: string;
  status: string;
  approval_status: string;
  source_type: string | null;
  source_id: string | null;
}

const FACT_APPROVAL = new Set(['approved', 'auto_approved']);

async function loadHolidaySet(startMonth: string, endMonth: string): Promise<Set<string>> {
  const [sy, sm] = startMonth.split('-').map(Number);
  const [ey, em] = endMonth.split('-').map(Number);
  // Месяц перед стартом — для маркера «после праздника» на 1-е число периода.
  const months: Array<{ year: number; month: number }> = [];
  let y = sy;
  let m = sm - 1;
  if (m < 1) { m = 12; y -= 1; }
  while (y < ey || (y === ey && m <= em)) {
    months.push({ year: y, month: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  const holidays = new Set<string>();
  await Promise.all(months.map(async ({ year, month }) => {
    const cal = await loadCalendarMonth(year, month);
    if (!cal) return;
    for (const iso of cal.holidays ?? []) holidays.add(iso.slice(0, 10));
    for (const iso of cal.mandatory_holidays ?? []) holidays.add(iso.slice(0, 10));
  }));
  return holidays;
}

export async function getDisciplineKpi(params: {
  scope: 'employee' | 'department';
  subject: string;
  startMonth: string;
  endMonth: string;
  metrics: KpiMetric[];
  employeeIds: number[];
  discipline: IDisciplineResult;
}): Promise<IDisciplineKpiResult> {
  const { scope, subject, startMonth, endMonth, metrics, employeeIds, discipline } = params;
  const metricSet = new Set(metrics);

  const rangeStart = `${startMonth}-01`;
  const [endY, endM] = endMonth.split('-').map(Number);
  const rangeEnd = new Date(Date.UTC(endY, endM, 0)).toISOString().slice(0, 10);
  const yearStart = `${endY}-01-01`;
  const yearEnd = `${endY}-12-31`;

  const needLeave = metricSet.has('sick') || metricSet.has('unpaid');

  let adjustments: AdjustmentRow[] = [];
  const yearUnpaidByEmp = new Map<number, number>();
  const leaveMeta = new Map<string, { createdDate: string; startDate: string }>();
  let holidays = new Set<string>();

  if (employeeIds.length > 0 && needLeave) {
    holidays = await loadHolidaySet(startMonth, endMonth);

    adjustments = (await query<AdjustmentRow>(
      `SELECT employee_id, work_date::text AS work_date, status, approval_status, source_type, source_id
         FROM attendance_adjustments
        WHERE employee_id = ANY($1::int[])
          AND work_date >= $2::date AND work_date <= $3::date
          AND status IN ('sick', 'sick_worked', 'unpaid')`,
      [employeeIds, rangeStart, rangeEnd],
    )) ?? [];

    if (metricSet.has('unpaid')) {
      const yearRows = (await query<{ employee_id: number; days: number }>(
        `SELECT employee_id, COUNT(*)::int AS days
           FROM attendance_adjustments
          WHERE employee_id = ANY($1::int[])
            AND status = 'unpaid'
            AND approval_status IN ('approved', 'auto_approved')
            AND work_date >= $2::date AND work_date <= $3::date
          GROUP BY employee_id`,
        [employeeIds, yearStart, yearEnd],
      )) ?? [];
      for (const r of yearRows) yearUnpaidByEmp.set(r.employee_id, Number(r.days) || 0);
    }

    const leaveIds = [...new Set(
      adjustments
        .filter(a => a.source_type === 'leave_request' && a.source_id && /^\d+$/.test(a.source_id))
        .map(a => Number(a.source_id)),
    )];
    if (leaveIds.length > 0) {
      const leaveRows = (await query<{ id: number; created_date: string; start_date: string }>(
        `SELECT id,
                (created_at AT TIME ZONE 'Europe/Moscow')::date::text AS created_date,
                start_date::text AS start_date
           FROM leave_requests
          WHERE id = ANY($1::bigint[])`,
        [leaveIds],
      )) ?? [];
      for (const r of leaveRows) leaveMeta.set(String(r.id), { createdDate: r.created_date, startDate: r.start_date });
    }
  }

  // Индексация фактических/pending дней по сотруднику и статусу.
  const factDays = new Map<number, { sick: LeaveDay[]; sickWorked: string[]; unpaid: LeaveDay[] }>();
  const pendingDays = new Map<number, { sick: number; unpaid: number }>();
  const ensureFact = (id: number) => {
    let v = factDays.get(id);
    if (!v) { v = { sick: [], sickWorked: [], unpaid: [] }; factDays.set(id, v); }
    return v;
  };
  const ensurePending = (id: number) => {
    let v = pendingDays.get(id);
    if (!v) { v = { sick: 0, unpaid: 0 }; pendingDays.set(id, v); }
    return v;
  };
  for (const a of adjustments) {
    const date = a.work_date.slice(0, 10);
    const leaveId = a.source_type === 'leave_request' ? a.source_id : null;
    const isFact = FACT_APPROVAL.has(a.approval_status);
    const isPending = a.approval_status === 'pending';
    if (a.status === 'sick') {
      if (isFact) ensureFact(a.employee_id).sick.push({ date, leaveId });
      else if (isPending) ensurePending(a.employee_id).sick += 1;
    } else if (a.status === 'sick_worked') {
      if (isFact) ensureFact(a.employee_id).sickWorked.push(date);
    } else if (a.status === 'unpaid') {
      if (isFact) ensureFact(a.employee_id).unpaid.push({ date, leaveId });
      else if (isPending) ensurePending(a.employee_id).unpaid += 1;
    }
  }

  // Сборка строк по сотрудникам.
  const rows: IDisciplineKpiRow[] = [];
  for (const employeeId of employeeIds) {
    const meta = discipline.employees[employeeId];
    const name = meta?.full_name || `#${employeeId}`;
    const department = meta?.department_id ? (discipline.departments[meta.department_id] || '—') : '—';

    let attendance: IKpiAttendance | null = null;
    if (metricSet.has('attendance')) {
      const agg = aggregateAttendance(employeeId, discipline);
      attendance = { ...agg, severity: severityFromLateCount(agg.lateCount) };
    }

    let sick: IKpiSick | null = null;
    if (metricSet.has('sick')) {
      const fact = factDays.get(employeeId);
      const cases = fact ? buildLeaveCases(fact.sick, holidays, leaveMeta) : [];
      const shortCaseCount = cases.filter(c => c.isShort).length;
      sick = {
        totalDays: fact ? fact.sick.length : 0,
        caseCount: cases.length,
        shortCaseCount,
        monFriCount: cases.filter(c => c.isMonFri).length,
        afterHolidayCount: cases.filter(c => c.isAfterHoliday).length,
        workedSickDays: fact ? fact.sickWorked.length : 0,
        cases,
        severity: severityFromShortSick(shortCaseCount),
      };
    }

    let unpaid: IKpiUnpaid | null = null;
    if (metricSet.has('unpaid')) {
      const fact = factDays.get(employeeId);
      const cases = fact ? buildLeaveCases(fact.unpaid, holidays, leaveMeta) : [];
      const daysThisYear = yearUnpaidByEmp.get(employeeId) ?? 0;
      unpaid = {
        totalDays: fact ? fact.unpaid.length : 0,
        caseCount: cases.length,
        retroactiveCaseCount: cases.filter(c => c.retroactive).length,
        daysThisYear,
        overLimit: daysThisYear > UNPAID_YEAR_LIMIT,
        cases,
        severity: severityFromUnpaidDays(daysThisYear),
      };
    }

    const pend = pendingDays.get(employeeId) ?? { sick: 0, unpaid: 0 };
    const pending: IKpiPending = {
      sickDays: metricSet.has('sick') ? pend.sick : 0,
      unpaidDays: metricSet.has('unpaid') ? pend.unpaid : 0,
    };

    const severity = maxSeverity([
      attendance?.severity ?? 'green',
      sick?.severity ?? 'green',
      unpaid?.severity ?? 'green',
    ]);

    rows.push({ employeeId, name, department, attendance, sick, unpaid, pending, severity });
  }

  // Для отдела оставляем только строки с какими-либо данными (топ-нарушители);
  // для сотрудника — всегда показываем единственную строку (в т.ч. «0 — идеально»).
  const visibleRows = scope === 'employee'
    ? rows
    : rows.filter(r => hasAnyData(r)).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || rowWeight(b) - rowWeight(a));

  const totals = buildTotals(rows, metricSet, employeeIds.length);
  const overallSeverity = maxSeverity(rows.map(r => r.severity));

  return { scope, subject, startMonth, endMonth, metrics, totals, rows: visibleRows, overallSeverity };
}

function hasAnyData(r: IDisciplineKpiRow): boolean {
  const a = r.attendance;
  const s = r.sick;
  const u = r.unpaid;
  return (
    (a ? a.lateCount + a.earlyCount + a.underworkCount + a.absenceCount : 0) > 0 ||
    (s ? s.totalDays + s.workedSickDays : 0) > 0 ||
    (u ? u.totalDays : 0) > 0 ||
    r.pending.sickDays + r.pending.unpaidDays > 0
  );
}

function rowWeight(r: IDisciplineKpiRow): number {
  const a = r.attendance ? r.attendance.lateCount + r.attendance.earlyCount + r.attendance.underworkCount + r.attendance.absenceCount : 0;
  const s = r.sick ? r.sick.totalDays : 0;
  const u = r.unpaid ? r.unpaid.totalDays : 0;
  return a + s + u;
}

function buildTotals(rows: IDisciplineKpiRow[], metricSet: Set<KpiMetric>, employeeCount: number): IDisciplineKpiTotals {
  const totals: IDisciplineKpiTotals = {
    employeeCount,
    attendance: null,
    sick: null,
    unpaid: null,
    pending: { sickDays: 0, unpaidDays: 0 },
  };

  if (metricSet.has('attendance')) {
    const a = { lateCount: 0, lateMinutes: 0, earlyCount: 0, underworkCount: 0, absenceCount: 0, workedHours: 0, normHours: 0 };
    for (const r of rows) {
      if (!r.attendance) continue;
      a.lateCount += r.attendance.lateCount;
      a.lateMinutes += r.attendance.lateMinutes;
      a.earlyCount += r.attendance.earlyCount;
      a.underworkCount += r.attendance.underworkCount;
      a.absenceCount += r.attendance.absenceCount;
      a.workedHours += r.attendance.workedHours;
      a.normHours += r.attendance.normHours;
    }
    totals.attendance = a;
  }

  if (metricSet.has('sick')) {
    const s = { totalDays: 0, caseCount: 0, shortCaseCount: 0, monFriCount: 0, afterHolidayCount: 0, workedSickDays: 0 };
    for (const r of rows) {
      if (!r.sick) continue;
      s.totalDays += r.sick.totalDays;
      s.caseCount += r.sick.caseCount;
      s.shortCaseCount += r.sick.shortCaseCount;
      s.monFriCount += r.sick.monFriCount;
      s.afterHolidayCount += r.sick.afterHolidayCount;
      s.workedSickDays += r.sick.workedSickDays;
      totals.pending.sickDays += r.pending.sickDays;
    }
    totals.sick = s;
  }

  if (metricSet.has('unpaid')) {
    const u = { totalDays: 0, caseCount: 0, retroactiveCaseCount: 0, overLimitEmployees: 0 };
    for (const r of rows) {
      if (!r.unpaid) continue;
      u.totalDays += r.unpaid.totalDays;
      u.caseCount += r.unpaid.caseCount;
      u.retroactiveCaseCount += r.unpaid.retroactiveCaseCount;
      if (r.unpaid.overLimit) u.overLimitEmployees += 1;
      totals.pending.unpaidDays += r.pending.unpaidDays;
    }
    totals.unpaid = u;
  }

  return totals;
}
