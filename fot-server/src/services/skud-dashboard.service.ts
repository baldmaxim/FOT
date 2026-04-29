/**
 * СКУД: логика дашборда руководителя (GET /api/skud/dashboard-stats).
 */
import { supabase } from '../config/database.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { collectDeptIds, DAY_NAMES, countWorkingDays, getInternalAccessPoints } from './skud-shared.service.js';
import { resolveSchedulesBulk, resolveSchedulesForPeriod, loadCalendarMonth, getEffectiveLateThreshold, getScheduleForDate, needsSkudCheck } from './schedule.service.js';
import { buildAttendanceEntries, type IAttendanceEmployee } from './attendance.service.js';
import type {
  IDashboardStatsParams,
  IDashboardStatsResult,
  IDashboardRisk,
  IDashboardWeekMetrics,
} from '../types/skud.types.js';

const WORK_START = '09:00:00';
const WORK_END = '18:00:00';
const LATE_THRESHOLD_DEFAULT = WORK_START;
const SLIGHTLY_LATE_THRESHOLD_DEFAULT = '09:15:00';
const DASHBOARD_PAGE_SIZE = 1000;

type DashboardSummaryRow = {
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
};

type DashboardEventRow = {
  event_date: string;
  event_time: string;
  employee_id: number;
};

type DashboardTodayEventRow = {
  event_time: string;
  employee_id: number;
};

// In-memory кэш по ключу (deptId, period, month).
// TTL 60с — фронт опрашивает раз в 120с, так что реальный egress падает в разы при
// множественных пользователях смотрящих один отдел.
const dashboardCache = new Map<string, { data: IDashboardStatsResult; expiresAt: number }>();
const DASHBOARD_TTL_MS = 60_000;

export function invalidateDashboardCache(): void {
  dashboardCache.clear();
}

// Считает часы по той же логике, что и табель руководителя (displayMode='capped_to_schedule'):
// учитывает attendance_adjustments.hours_override, замыкает open entry по now() для «сегодня»
// и ограничивает часы длительностью смены. buildAttendanceEntries работает по одному
// календарному месяцу, поэтому диапазон режется помесячно.
async function loadAttendanceHoursMap(params: {
  employees: IAttendanceEmployee[];
  startDate: string;
  endDate: string;
  todayStr: string;
}): Promise<Map<number, Map<string, number>>> {
  const { employees, startDate, endDate, todayStr } = params;
  const result = new Map<number, Map<string, number>>();
  if (employees.length === 0 || startDate > endDate) return result;

  const dailySchedulesMap = await resolveSchedulesForPeriod(
    employees.map(e => ({ id: e.id, work_category: e.work_category ?? null })),
    startDate,
    endDate,
  );

  const months: Array<{ year: number; month: number; rangeStart: string; rangeEnd: string }> = [];
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  let curY = sy;
  let curM = sm;
  while (curY < ey || (curY === ey && curM <= em)) {
    const monthStart = `${curY}-${String(curM).padStart(2, '0')}-01`;
    const lastDay = new Date(curY, curM, 0).getDate();
    const monthEnd = `${curY}-${String(curM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const rangeStart = startDate > monthStart ? startDate : monthStart;
    const rangeEnd = endDate < monthEnd ? endDate : monthEnd;
    months.push({ year: curY, month: curM, rangeStart, rangeEnd });
    curM++;
    if (curM > 12) { curM = 1; curY++; }
  }

  await Promise.all(months.map(async (m) => {
    const calendarMonth = await loadCalendarMonth(m.year, m.month);
    const { entries } = await buildAttendanceEntries({
      employees,
      startDate: m.rangeStart,
      endDate: m.rangeEnd,
      dailySchedulesMap,
      calendarMonth,
      todayStr,
      displayMode: 'capped_to_schedule',
    });
    for (const entry of entries) {
      const hours = entry.display_hours_worked ?? entry.hours_worked ?? 0;
      if (!result.has(entry.employee_id)) {
        result.set(entry.employee_id, new Map());
      }
      result.get(entry.employee_id)!.set(entry.work_date, hours);
    }
  }));

  return result;
}

async function fetchSummaryPages(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<DashboardSummaryRow[]> {
  if (employeeIds.length === 0) return [];

  const rows: DashboardSummaryRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('skud_daily_summary')
      .select('employee_id, date, first_entry, last_exit, total_hours, is_present')
      .in('employee_id', employeeIds)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true })
      .order('employee_id', { ascending: true })
      .range(offset, offset + DASHBOARD_PAGE_SIZE - 1);

    if (error) throw error;

    const page = (data || []) as DashboardSummaryRow[];
    if (page.length === 0) break;

    rows.push(...page);
    if (page.length < DASHBOARD_PAGE_SIZE) break;
    offset += DASHBOARD_PAGE_SIZE;
  }

  return rows;
}

async function fetchEntryEventPages(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<DashboardEventRow[]> {
  if (employeeIds.length === 0) return [];

  const rows: DashboardEventRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('skud_events')
      .select('event_date, event_time, employee_id')
      .eq('direction', 'entry')
      .in('employee_id', employeeIds)
      .gte('event_date', startDate)
      .lte('event_date', endDate)
      .order('event_date', { ascending: true })
      .order('employee_id', { ascending: true })
      .order('event_time', { ascending: true })
      .range(offset, offset + DASHBOARD_PAGE_SIZE - 1);

    if (error) throw error;

    const page = (data || []) as DashboardEventRow[];
    if (page.length === 0) break;

    rows.push(...page);
    if (page.length < DASHBOARD_PAGE_SIZE) break;
    offset += DASHBOARD_PAGE_SIZE;
  }

  return rows;
}

async function fetchTodayEventPages(
  employeeIds: number[],
  date: string,
  direction: 'entry' | 'exit',
): Promise<DashboardTodayEventRow[]> {
  if (employeeIds.length === 0) return [];

  const rows: DashboardTodayEventRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('skud_events')
      .select('event_time, employee_id')
      .eq('event_date', date)
      .eq('direction', direction)
      .in('employee_id', employeeIds)
      .order('employee_id', { ascending: true })
      .order('event_time', { ascending: true })
      .range(offset, offset + DASHBOARD_PAGE_SIZE - 1);

    if (error) throw error;

    const page = (data || []) as DashboardTodayEventRow[];
    if (page.length === 0) break;

    rows.push(...page);
    if (page.length < DASHBOARD_PAGE_SIZE) break;
    offset += DASHBOARD_PAGE_SIZE;
  }

  return rows;
}

export async function getDashboardStats(
  params: IDashboardStatsParams,
): Promise<IDashboardStatsResult> {
  const { departmentId, period, month } = params;

  const cacheKey = `${departmentId ?? 'all'}|${period ?? 'default'}|${month ?? 'current'}`;
  const cached = dashboardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const deptIds = await collectDeptIds(departmentId);

  // Загрузить сотрудников отдела (с org_department_id для графиков)
  const [empResult, internalPoints] = await Promise.all([
    supabase
      .from('employees')
      .select('id, full_name, org_department_id, work_category')
      .eq('is_archived', false)
      .eq('employment_status', 'active')
      .in('org_department_id', deptIds),
    getInternalAccessPoints(),
  ]);

  const employees = empResult.data;
  if (!employees || employees.length === 0) {
    const empty: IDashboardStatsResult = {
      lateToday: 0, lateYesterday: 0,
      punctuality: { onTime: 0, slightlyLate: 0, veryLate: 0, absent: 0 },
      avgArrivalByDay: [], risks: [], hourlyActivity: [],
      weekComparison: null, topLate: [], periodStats: null,
      earlyLeaveToday: 0, recentEvents: [],
      todayEntriesCount: 0, todayExitsCount: 0,
    };
    dashboardCache.set(cacheKey, { data: empty, expiresAt: Date.now() + DASHBOARD_TTL_MS });
    return empty;
  }

  const empIds = employees.map(e => e.id);
  const empNameMap = new Map<number, string>();
  for (const e of employees) {
    empNameMap.set(e.id, e.full_name || '');
  }

  // Resolve графики — нужны для пороговых значений и исключения remote
  const empListForSched = employees.map(e => ({
    id: e.id as number,
    work_category: (e.work_category as string | null) || null,
  }));
  const schedulesMap = await resolveSchedulesBulk(empListForSched, formatDateToISO(new Date()));

  // Множество сотрудников, которым не нужен СКУД-контроль сегодня
  const remoteEmpIds = new Set<number>();
  for (const [empId, sched] of schedulesMap) {
    if (!needsSkudCheck(sched, new Date())) remoteEmpIds.add(empId);
  }

  // Фильтрация: офисные сотрудники (для подсчёта опозданий/присутствия)
  const officeEmpIds = empIds.filter(id => !remoteEmpIds.has(id));

  // Даты
  const today = new Date();
  const todayStr = formatDateToISO(today);
  // Rolling 7-day окно недели: симметричные current/previous — сравнение и усреднения
  // считаются на одинаковом количестве дней вне зависимости от текущего дня недели.
  const weekEnd = new Date(today);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);
  const prevWeekEnd = new Date(weekStart);
  prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
  const prevWeekStart = new Date(prevWeekEnd);
  prevWeekStart.setDate(prevWeekStart.getDate() - 6);

  const weekStartStr = formatDateToISO(weekStart);
  const weekEndStr = formatDateToISO(weekEnd);
  const prevWeekStartStr = formatDateToISO(prevWeekStart);
  const prevWeekEndStr = formatDateToISO(prevWeekEnd);

  // Месяц: если передан month=YYYY-MM, используем его; иначе текущий
  let targetMonthYear = today.getFullYear();
  let targetMonthIdx = today.getMonth();
  if (period === 'month' && month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    targetMonthYear = y;
    targetMonthIdx = m - 1;
  }
  const monthStart = new Date(targetMonthYear, targetMonthIdx, 1);
  const monthEnd = new Date(targetMonthYear, targetMonthIdx + 1, 0); // последний день месяца
  const monthStartStr = formatDateToISO(monthStart);
  // Если выбранный месяц — текущий, конец = сегодня; иначе = конец месяца
  const isCurrentMonth = targetMonthYear === today.getFullYear() && targetMonthIdx === today.getMonth();
  const monthEndStr = isCurrentMonth ? todayStr : formatDateToISO(monthEnd);
  const prevMonthStart = new Date(targetMonthYear, targetMonthIdx - 1, 1);
  const prevMonthEnd = new Date(targetMonthYear, targetMonthIdx, 0);
  const prevMonthStartStr = formatDateToISO(prevMonthStart);
  const prevMonthEndStr = formatDateToISO(prevMonthEnd);

  // Вчера (рабочий день)
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  while (yesterday.getDay() === 0 || yesterday.getDay() === 6) {
    yesterday.setDate(yesterday.getDate() - 1);
  }
  const yesterdayStr = formatDateToISO(yesterday);

  // Period-aware диапазоны
  let periodStartStr: string;
  let periodEndStr: string;
  let prevPeriodStartStr: string;
  let prevPeriodEndStr: string;

  if (period === 'month') {
    periodStartStr = monthStartStr;
    periodEndStr = monthEndStr;
    prevPeriodStartStr = prevMonthStartStr;
    prevPeriodEndStr = prevMonthEndStr;
  } else if (period === 'week') {
    periodStartStr = weekStartStr;
    periodEndStr = weekEndStr;
    prevPeriodStartStr = prevWeekStartStr;
    prevPeriodEndStr = prevWeekEndStr;
  } else {
    periodStartStr = todayStr;
    periodEndStr = todayStr;
    prevPeriodStartStr = yesterdayStr;
    prevPeriodEndStr = yesterdayStr;
  }

  const summaryStartDate = period === 'month' ? prevPeriodStartStr : period === 'week' ? prevWeekStartStr : yesterdayStr;
  const summaryEndDate = period === 'month' && !isCurrentMonth ? periodEndStr : todayStr;

  // 4 недели назад (rolling 28 дней) — для графика «средний приход по дням недели» на week-вкладке.
  const fourWeeksAgo = new Date(today);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 27);
  const fourWeeksAgoStr = formatDateToISO(fourWeeksAgo);
  const arrivalRangeStart = period === 'today' ? weekStartStr : period === 'month' ? monthStartStr : fourWeeksAgoStr;
  const arrivalRangeEnd = period === 'month' ? periodEndStr : todayStr;
  const shouldFetchPeriodEvents = period !== 'today';
  const canReusePeriodEventsForArrival = shouldFetchPeriodEvents
    && arrivalRangeStart === periodStartStr
    && arrivalRangeEnd === periodEndStr;
  const periodEventsPromise = shouldFetchPeriodEvents
    ? fetchEntryEventPages(empIds, periodStartStr, periodEndStr)
    : Promise.resolve([]);
  const arrivalEventsPromise = canReusePeriodEventsForArrival
    ? periodEventsPromise
    : fetchEntryEventPages(empIds, arrivalRangeStart, arrivalRangeEnd);

  const attendanceEmployees: IAttendanceEmployee[] = employees.map(e => ({
    id: e.id as number,
    full_name: (e.full_name as string | null) || null,
    work_category: (e.work_category as string | null) || null,
  }));

  // Параллельные запросы: daily_summary + 3 типа событий + часы по логике табеля
  const [summaries, todayEvents, todayExitEvents, recentEventsRes, periodEvents, arrivalEvents, attendanceHoursMap] = await Promise.all([
    fetchSummaryPages(empIds, summaryStartDate, summaryEndDate),
    fetchTodayEventPages(empIds, todayStr, 'entry'),
    fetchTodayEventPages(empIds, todayStr, 'exit'),
    supabase
      .from('skud_events')
      .select('event_time, employee_id, physical_person, access_point, direction')
      .eq('event_date', todayStr)
      .in('employee_id', empIds)
      .order('event_time', { ascending: false })
      .limit(50),
    periodEventsPromise,
    arrivalEventsPromise,
    loadAttendanceHoursMap({
      employees: attendanceEmployees,
      startDate: summaryStartDate,
      endDate: summaryEndDate,
      todayStr,
    }),
  ]);

  const recentEventsRaw = recentEventsRes.data;


  // --- Агрегация ---

  // Хелпер: получить порог опоздания для сотрудника на конкретную дату
  const getLateThresholdFor = (empId: number, dateStr: string): string => {
    const sched = schedulesMap.get(empId);
    if (!sched) return LATE_THRESHOLD_DEFAULT;
    const dateObj = new Date(dateStr + 'T00:00:00');
    return getEffectiveLateThreshold(sched, dateObj);
  };

  const getSlightlyLateFor = (empId: number, dateStr: string): string => {
    const sched = schedulesMap.get(empId);
    if (!sched) return SLIGHTLY_LATE_THRESHOLD_DEFAULT;
    const dateObj = new Date(dateStr + 'T00:00:00');
    const dayParams = getScheduleForDate(sched, dateObj);
    const [h, m] = dayParams.work_start.split(':').map(Number);
    const totalMin = h * 60 + m + sched.late_threshold_minutes + 15;
    return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}:00`;
  };

  // Late today / yesterday
  let lateToday = 0;
  let lateYesterday = 0;
  for (const s of summaries || []) {
    if (!s.first_entry) continue;
    if (remoteEmpIds.has(s.employee_id)) continue;
    const threshold = getLateThresholdFor(s.employee_id, s.date);
    if (s.date === todayStr && s.first_entry > threshold) lateToday++;
    if (s.date === yesterdayStr && s.first_entry > threshold) lateYesterday++;
  }

  // Period summaries
  const periodSummaries = (summaries || []).filter(s => s.date >= periodStartStr && s.date <= periodEndStr);
  const prevPeriodSummaries = (summaries || []).filter(s => s.date >= prevPeriodStartStr && s.date <= prevPeriodEndStr);

  // Punctuality (только офисные сотрудники)
  const periodWithEntry = periodSummaries.filter(s => s.first_entry && !remoteEmpIds.has(s.employee_id));
  let onTimeCount = 0;
  let slightlyLateCount = 0;
  let veryLateCount = 0;
  for (const s of periodWithEntry) {
    const threshold = getLateThresholdFor(s.employee_id, s.date);
    const slightlyThreshold = getSlightlyLateFor(s.employee_id, s.date);
    if (s.first_entry! <= threshold) onTimeCount++;
    else if (s.first_entry! <= slightlyThreshold) slightlyLateCount++;
    else veryLateCount++;
  }
  const calendarWorkDays = countWorkingDays(periodStartStr, periodEndStr);
  const actualWorkDays = calendarWorkDays || 1;

  // 100% = пришедшие сотрудники, absent не считаем
  // Для week/month — средняя пунктуальность за все дни периода
  const totalArrived = periodWithEntry.length || 1;
  const punctuality = {
    onTime: Math.round((onTimeCount / totalArrived) * 100),
    slightlyLate: Math.round((slightlyLateCount / totalArrived) * 100),
    veryLate: Math.round((veryLateCount / totalArrived) * 100),
    absent: 0,
  };

  // Average arrival by weekday
  const firstEntryMap = new Map<string, string>();
  for (const ev of arrivalEvents || []) {
    const key = `${ev.employee_id}:${ev.event_date}`;
    if (!firstEntryMap.has(key)) firstEntryMap.set(key, ev.event_time);
  }

  const arrivalByDow: number[][] = [[], [], [], [], []];
  const todayDowIdx = today.getDay() === 0 ? 6 : today.getDay() - 1;
  for (const [key, time] of firstEntryMap) {
    const date = key.split(':').slice(1).join(':');
    const d = new Date(date + 'T00:00:00');
    const dow = d.getDay();
    const dowIdx = dow === 0 ? 6 : dow - 1;
    if (dowIdx >= 5) continue;
    if (period === 'today' && dowIdx > todayDowIdx) continue;
    const [h, m] = time.split(':').map(Number);
    arrivalByDow[dowIdx].push(h * 60 + m);
  }
  const avgArrivalByDay = DAY_NAMES.map((name, i) => {
    if (period === 'today' && i > todayDowIdx) return { day: name, avgTime: null, date: '', isToday: i === todayDowIdx };
    const times = arrivalByDow[i];
    if (times.length === 0) return { day: name, avgTime: null, date: '', isToday: period === 'today' && i === todayDowIdx };
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const avgH = String(Math.floor(avg / 60)).padStart(2, '0');
    const avgM = String(avg % 60).padStart(2, '0');
    return { day: name, avgTime: `${avgH}:${avgM}`, date: '', isToday: period === 'today' && i === todayDowIdx };
  });

  // Risks
  const periodLabel = period === 'today' ? 'сегодня' : period === 'week' ? 'неделю' : 'месяц';
  const lateCountByEmp = new Map<number, number>();
  const earlyLeaveByEmp = new Map<number, number>();
  for (const s of periodSummaries) {
    if (remoteEmpIds.has(s.employee_id)) continue;
    const threshold = getLateThresholdFor(s.employee_id, s.date);
    if (s.first_entry && s.first_entry > threshold) {
      lateCountByEmp.set(s.employee_id, (lateCountByEmp.get(s.employee_id) || 0) + 1);
    }
    if (s.last_exit && s.last_exit < WORK_END && s.is_present) {
      earlyLeaveByEmp.set(s.employee_id, (earlyLeaveByEmp.get(s.employee_id) || 0) + 1);
    }
  }

  const periodWorkDays = actualWorkDays || 1;
  const lateThreshold = period === 'today' ? 1 : Math.max(1, Math.min(3, periodWorkDays - 1));
  const earlyThreshold = period === 'today' ? 1 : Math.max(1, Math.min(2, periodWorkDays - 1));
  const highThreshold = period === 'today' ? 1 : Math.max(2, Math.ceil(periodWorkDays * 0.4));
  const risks: IDashboardRisk[] = [];
  for (const [empId, count] of lateCountByEmp) {
    if (count >= lateThreshold) {
      risks.push({ employee_id: empId, full_name: empNameMap.get(empId) || '', reason: `${count} опозданий за ${periodLabel}`, severity: count >= highThreshold ? 'high' : 'medium' });
    }
  }
  for (const [empId, count] of earlyLeaveByEmp) {
    if (count >= earlyThreshold && !risks.find(r => r.employee_id === empId)) {
      risks.push({ employee_id: empId, full_name: empNameMap.get(empId) || '', reason: `Ранние уходы ${count} дня`, severity: 'medium' });
    }
  }
  risks.sort((a, b) => (a.severity === 'high' ? -1 : 1) - (b.severity === 'high' ? -1 : 1));

  // Hourly activity
  const hourlyMap = new Map<number, number>();
  for (let h = 7; h <= 19; h++) hourlyMap.set(h, 0);

  if (period === 'today') {
    for (const evt of todayEvents || []) {
      if (!evt.event_time) continue;
      const hour = parseInt(evt.event_time.split(':')[0], 10);
      if (hour >= 7 && hour <= 19) {
        hourlyMap.set(hour, (hourlyMap.get(hour) || 0) + 1);
      }
    }
  } else {
    for (const evt of periodEvents || []) {
      if (!evt.event_time) continue;
      const hour = parseInt(evt.event_time.split(':')[0], 10);
      if (hour >= 7 && hour <= 19) {
        hourlyMap.set(hour, (hourlyMap.get(hour) || 0) + 1);
      }
    }
    const workDaysCount = actualWorkDays || 1;
    for (const [h, count] of hourlyMap) {
      hourlyMap.set(h, Math.round(count / workDaysCount));
    }
  }
  const hourlyActivity = [...hourlyMap.entries()].map(([hour, count]) => ({ hour, count }));

  // Period comparison
  const calcWeekMetrics = (weekData: typeof periodSummaries, expectedRecords: number): IDashboardWeekMetrics => {
    const withEntry = weekData.filter(s => s.first_entry && !remoteEmpIds.has(s.employee_id));
    const total = expectedRecords > 0 ? expectedRecords : 1;
    const attendanceRate = Math.round((withEntry.length / total) * 100);

    let avgArrivalMin = 0;
    if (withEntry.length > 0) {
      const totalMin = withEntry.reduce((sum, s) => {
        const [h, m] = s.first_entry!.split(':').map(Number);
        return sum + h * 60 + m;
      }, 0);
      avgArrivalMin = Math.round(totalMin / withEntry.length);
    }
    const avgArrival = withEntry.length > 0
      ? `${String(Math.floor(avgArrivalMin / 60)).padStart(2, '0')}:${String(avgArrivalMin % 60).padStart(2, '0')}`
      : '--:--';

    // Часы берём из карты, посчитанной по логике табеля (capped_to_schedule):
    // attendance_adjustments.hours_override → skud_daily_summary → пересчёт по объектам
    // с лимитом длительности смены и замыканием open entry на now() для «сегодня».
    const hoursArr = weekData
      .map(s => attendanceHoursMap.get(s.employee_id)?.get(s.date) ?? 0)
      .filter(h => h > 0);
    const avgHours = hoursArr.length > 0
      ? Math.round((hoursArr.reduce((a, b) => a + b, 0) / hoursArr.length) * 10) / 10
      : 0;

    const lateCount = withEntry.filter(s => {
      return s.first_entry! > getLateThresholdFor(s.employee_id, s.date);
    }).length;

    return { attendanceRate, avgArrival, avgHours, lateCount };
  };

  const prevWorkDays = countWorkingDays(prevPeriodStartStr, prevPeriodEndStr);
  const weekComparison = {
    thisWeek: calcWeekMetrics(periodSummaries, officeEmpIds.length * (actualWorkDays || 1)),
    lastWeek: calcWeekMetrics(prevPeriodSummaries, officeEmpIds.length * prevWorkDays),
  };

  // Top late
  const topLateCountByEmp = new Map<number, number>();
  const avgArrivalByEmp = new Map<number, number>();
  const arrivalCountByEmp = new Map<number, number>();
  const lateDetailsByEmp = new Map<number, Array<{ date: string; arrival: string }>>();
  for (const s of periodSummaries) {
    if (s.first_entry) {
      const [h, m] = s.first_entry.split(':').map(Number);
      const min = h * 60 + m;
      avgArrivalByEmp.set(s.employee_id, (avgArrivalByEmp.get(s.employee_id) || 0) + min);
      arrivalCountByEmp.set(s.employee_id, (arrivalCountByEmp.get(s.employee_id) || 0) + 1);
      if (remoteEmpIds.has(s.employee_id)) continue;
      if (s.first_entry > getLateThresholdFor(s.employee_id, s.date)) {
        topLateCountByEmp.set(s.employee_id, (topLateCountByEmp.get(s.employee_id) || 0) + 1);
        const details = lateDetailsByEmp.get(s.employee_id) || [];
        details.push({ date: s.date, arrival: s.first_entry.slice(0, 5) });
        lateDetailsByEmp.set(s.employee_id, details);
      }
    }
  }
  const topLate = [...topLateCountByEmp.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([empId, lateCnt]) => {
      const totalMin = avgArrivalByEmp.get(empId) || 0;
      const cnt = arrivalCountByEmp.get(empId) || 1;
      const avg = Math.round(totalMin / cnt);
      return {
        employee_id: empId,
        full_name: empNameMap.get(empId) || '',
        lateCount: lateCnt,
        avgArrival: `${String(Math.floor(avg / 60)).padStart(2, '0')}:${String(avg % 60).padStart(2, '0')}`,
        lateDetails: (lateDetailsByEmp.get(empId) || []).sort((a, b) => b.date.localeCompare(a.date)),
      };
    });

  // Period stats
  let periodStats: IDashboardStatsResult['periodStats'] = null;
  if (period === 'week' || period === 'month') {
    const pWorkDays = actualWorkDays; // календарные рабочие дни (countWorkingDays)

    // Считаем уникальных сотрудников за каждый день (пришёл до 18:00 = присутствовал)
    const dailyPresent = new Map<string, Set<number>>();
    for (const s of periodSummaries) {
      if (s.first_entry && s.first_entry <= WORK_END && !remoteEmpIds.has(s.employee_id)) {
        if (!dailyPresent.has(s.date)) dailyPresent.set(s.date, new Set());
        dailyPresent.get(s.date)!.add(s.employee_id);
      }
    }
    const totalPresent = [...dailyPresent.values()].reduce((sum, set) => sum + set.size, 0);
    const avgPresent = Math.round(totalPresent / pWorkDays);
    const avgAbsent = Math.max(0, officeEmpIds.length - avgPresent);

    const pExpectedTotal = officeEmpIds.length * pWorkDays;
    const attendanceRate = pExpectedTotal > 0 ? Math.round((totalPresent / pExpectedTotal) * 100) : 0;

    console.log('[dashboard-stats]', {
      period,
      periodStartStr,
      periodEndStr,
      pWorkDays,
      officeEmpCount: officeEmpIds.length,
      remoteCount: remoteEmpIds.size,
      totalEmp: empIds.length,
      summariesLoaded: summaries.length,
      arrivalEventsLoaded: arrivalEvents.length,
      periodEntryEventsLoaded: periodEvents.length,
      todayEntryEventsLoaded: todayEvents.length,
      todayExitEventsLoaded: todayExitEvents.length,
      totalPresent,
      avgPresent,
      dailyBreakdown: [...dailyPresent.entries()].map(([d, s]) => `${d}:${s.size}`),
    });

    const pLateCount = periodSummaries.filter(s => s.first_entry && !remoteEmpIds.has(s.employee_id) && s.first_entry > getLateThresholdFor(s.employee_id, s.date)).length;
    const prevLateCount = prevPeriodSummaries.filter(s => s.first_entry && !remoteEmpIds.has(s.employee_id) && s.first_entry > getLateThresholdFor(s.employee_id, s.date)).length;

    periodStats = { avgPresent, avgAbsent, attendanceRate, lateCount: pLateCount, prevLateCount };
  }

  // Exited today — уникальные сотрудники, у которых зафиксирован выход
  const exitedEmployees = new Set((todayExitEvents || []).map(e => e.employee_id));
  const earlyLeaveToday = exitedEmployees.size;

  // Today entries/exits count
  const todayEntriesCount = (todayEvents || []).length;
  const todayExitsCount = (todayExitEvents || []).length;

  // Recent events
  const recentEvents = (recentEventsRaw || []).map(ev => ({
    time: ev.event_time ? ev.event_time.slice(0, 5) : '',
    name: ev.employee_id ? (empNameMap.get(ev.employee_id) || ev.physical_person || 'Неизвестный') : (ev.physical_person || 'Неизвестный'),
    accessPoint: ev.access_point || '',
    direction: ev.direction as 'entry' | 'exit' | null,
    isInternal: internalPoints.size > 0 && !!ev.access_point && internalPoints.has(ev.access_point.trim()),
  }));

  const result: IDashboardStatsResult = {
    lateToday, lateYesterday, punctuality, avgArrivalByDay, risks,
    hourlyActivity, weekComparison, topLate, periodStats,
    earlyLeaveToday, recentEvents,
    todayEntriesCount, todayExitsCount,
  };

  dashboardCache.set(cacheKey, { data: result, expiresAt: Date.now() + DASHBOARD_TTL_MS });
  return result;
}
