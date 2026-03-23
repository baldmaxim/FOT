/**
 * СКУД: логика дашборда руководителя (GET /api/skud/dashboard-stats).
 */
import { supabase } from '../config/database.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { collectDeptIds, getMonday, DAY_NAMES, countWorkingDays } from './skud-shared.service.js';
import type {
  IDashboardStatsParams,
  IDashboardStatsResult,
  IDashboardRisk,
  IDashboardWeekMetrics,
} from '../types/skud.types.js';

const LATE_THRESHOLD = '09:00:00';
const SLIGHTLY_LATE_THRESHOLD = '09:15:00';

export async function getDashboardStats(
  params: IDashboardStatsParams,
): Promise<IDashboardStatsResult> {
  const { organizationId, departmentId, period } = params;

  const deptIds = await collectDeptIds(departmentId, organizationId);

  // Загрузить сотрудников отдела
  let empQuery = supabase
    .from('employees')
    .select('id, full_name')
    .eq('is_archived', false)
    .eq('employment_status', 'active')
    .in('org_department_id', deptIds);
  if (organizationId) empQuery = empQuery.eq('organization_id', organizationId);

  const { data: employees } = await empQuery;
  if (!employees || employees.length === 0) {
    return {
      lateToday: 0, lateYesterday: 0,
      punctuality: { onTime: 0, slightlyLate: 0, veryLate: 0, absent: 0 },
      avgArrivalByDay: [], risks: [], hourlyActivity: [],
      weekComparison: null, topLate: [], periodStats: null,
      earlyLeaveToday: 0, recentEvents: [], anomalies: { refusals: 0, multipleEntry: 0 },
      todayEntriesCount: 0, todayExitsCount: 0,
    };
  }

  const empIds = employees.map(e => e.id);
  const empNameMap = new Map<number, string>();
  for (const e of employees) {
    empNameMap.set(e.id, e.full_name || '');
  }

  // Даты
  const today = new Date();
  const todayStr = formatDateToISO(today);
  const monday = getMonday(today);
  const lastMonday = new Date(monday);
  lastMonday.setDate(lastMonday.getDate() - 7);
  const lastFriday = new Date(lastMonday);
  lastFriday.setDate(lastFriday.getDate() + 4);

  const mondayStr = formatDateToISO(monday);
  const lastMondayStr = formatDateToISO(lastMonday);
  const lastFridayStr = formatDateToISO(lastFriday);

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthStartStr = formatDateToISO(monthStart);
  const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
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
    periodEndStr = todayStr;
    prevPeriodStartStr = prevMonthStartStr;
    prevPeriodEndStr = prevMonthEndStr;
  } else if (period === 'week') {
    periodStartStr = mondayStr;
    periodEndStr = todayStr;
    prevPeriodStartStr = lastMondayStr;
    prevPeriodEndStr = lastFridayStr;
  } else {
    periodStartStr = todayStr;
    periodEndStr = todayStr;
    prevPeriodStartStr = yesterdayStr;
    prevPeriodEndStr = yesterdayStr;
  }

  const summaryStartDate = period === 'month' ? prevMonthStartStr : period === 'week' ? lastMondayStr : yesterdayStr;

  // 4 недели назад
  const fourWeeksAgo = new Date(monday);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 21);
  const fourWeeksAgoStr = formatDateToISO(fourWeeksAgo);

  // Запрос daily_summary
  const { data: summaries } = await supabase
    .from('skud_daily_summary')
    .select('employee_id, date, first_entry, last_exit, total_hours, is_present')
    .in('employee_id', empIds)
    .gte('date', summaryStartDate)
    .lte('date', todayStr);

  // Запрос entry-событий за сегодня
  let eventsQuery = supabase
    .from('skud_events')
    .select('event_time, employee_id')
    .eq('event_date', todayStr)
    .eq('direction', 'entry')
    .in('employee_id', empIds);
  if (organizationId) eventsQuery = eventsQuery.eq('organization_id', organizationId);
  const { data: todayEvents } = await eventsQuery;

  // Запрос exit-событий за сегодня
  let exitEventsQuery = supabase
    .from('skud_events')
    .select('event_time, employee_id')
    .eq('event_date', todayStr)
    .eq('direction', 'exit')
    .in('employee_id', empIds);
  if (organizationId) exitEventsQuery = exitEventsQuery.eq('organization_id', organizationId);
  const { data: todayExitEvents } = await exitEventsQuery;

  // Запрос последних событий
  let recentEvQuery = supabase
    .from('skud_events')
    .select('event_time, employee_id, physical_person, access_point, direction')
    .eq('event_date', todayStr)
    .in('employee_id', empIds)
    .order('event_time', { ascending: false })
    .limit(50);
  if (organizationId) recentEvQuery = recentEvQuery.eq('organization_id', organizationId);
  const { data: recentEventsRaw } = await recentEvQuery;

  // Запрос аномалий
  let anomalyQuery = supabase
    .from('skud_events')
    .select('id, employee_id, physical_person, direction')
    .eq('event_date', todayStr)
    .is('employee_id', null);
  if (organizationId) anomalyQuery = anomalyQuery.eq('organization_id', organizationId);
  const { data: unknownEvents } = await anomalyQuery;

  // --- Агрегация ---

  // Late today / yesterday
  let lateToday = 0;
  let lateYesterday = 0;
  for (const s of summaries || []) {
    if (!s.first_entry) continue;
    if (s.date === todayStr && s.first_entry > LATE_THRESHOLD) lateToday++;
    if (s.date === yesterdayStr && s.first_entry > LATE_THRESHOLD) lateYesterday++;
  }

  // Period summaries
  const periodSummaries = (summaries || []).filter(s => s.date >= periodStartStr && s.date <= periodEndStr);
  const prevPeriodSummaries = (summaries || []).filter(s => s.date >= prevPeriodStartStr && s.date <= prevPeriodEndStr);

  // Punctuality
  const periodWithEntry = periodSummaries.filter(s => s.first_entry);
  let onTimeCount = 0;
  let slightlyLateCount = 0;
  let veryLateCount = 0;
  for (const s of periodWithEntry) {
    if (s.first_entry! <= LATE_THRESHOLD) onTimeCount++;
    else if (s.first_entry! <= SLIGHTLY_LATE_THRESHOLD) slightlyLateCount++;
    else veryLateCount++;
  }
  const daysWithPresence = new Set(periodWithEntry.map(s => s.date));
  const actualWorkDays = daysWithPresence.size;
  const expectedTotal = empIds.length * (actualWorkDays || 1);
  const absentCount = Math.max(0, expectedTotal - periodWithEntry.length);
  const punctuality = {
    onTime: Math.round((onTimeCount / expectedTotal) * 100),
    slightlyLate: Math.round((slightlyLateCount / expectedTotal) * 100),
    veryLate: Math.round((veryLateCount / expectedTotal) * 100),
    absent: Math.round((absentCount / expectedTotal) * 100),
  };

  // Average arrival by weekday
  const arrivalRangeStart = period === 'today' ? mondayStr : period === 'month' ? monthStartStr : fourWeeksAgoStr;
  const arrivalRangeEnd = todayStr;
  let arrivalEventsQuery = supabase
    .from('skud_events')
    .select('event_date, event_time, employee_id')
    .eq('direction', 'entry')
    .in('employee_id', empIds)
    .gte('event_date', arrivalRangeStart)
    .lte('event_date', arrivalRangeEnd)
    .order('event_time', { ascending: true });
  if (organizationId) arrivalEventsQuery = arrivalEventsQuery.eq('organization_id', organizationId);
  const { data: arrivalEvents } = await arrivalEventsQuery;

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
    if (s.first_entry && s.first_entry > LATE_THRESHOLD) {
      lateCountByEmp.set(s.employee_id, (lateCountByEmp.get(s.employee_id) || 0) + 1);
    }
    if (s.last_exit && s.last_exit < '17:00:00' && s.is_present) {
      earlyLeaveByEmp.set(s.employee_id, (earlyLeaveByEmp.get(s.employee_id) || 0) + 1);
    }
  }

  const lateThreshold = period === 'today' ? 1 : 3;
  const earlyThreshold = period === 'today' ? 1 : 2;
  const highThreshold = period === 'today' ? 1 : period === 'week' ? 4 : 8;
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
    let periodEventsQuery = supabase
      .from('skud_events')
      .select('event_time, event_date')
      .eq('direction', 'entry')
      .in('employee_id', empIds)
      .gte('event_date', periodStartStr)
      .lte('event_date', periodEndStr);
    if (organizationId) periodEventsQuery = periodEventsQuery.eq('organization_id', organizationId);
    const { data: periodEvents } = await periodEventsQuery;

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
    const withEntry = weekData.filter(s => s.first_entry);
    const presentDays = weekData.filter(s => s.is_present).length;
    const total = expectedRecords > 0 ? expectedRecords : 1;
    const attendanceRate = Math.round((presentDays / total) * 100);

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

    const withHours = weekData.filter(s => s.total_hours != null && s.total_hours > 0);
    const avgHours = withHours.length > 0
      ? Math.round((withHours.reduce((sum, s) => sum + (s.total_hours || 0), 0) / withHours.length) * 10) / 10
      : 0;

    const lateCount = withEntry.filter(s => s.first_entry! > LATE_THRESHOLD).length;

    return { attendanceRate, avgArrival, avgHours, lateCount };
  };

  const prevWorkDays = countWorkingDays(prevPeriodStartStr, prevPeriodEndStr);
  const weekComparison = {
    thisWeek: calcWeekMetrics(periodSummaries, empIds.length * actualWorkDays),
    lastWeek: calcWeekMetrics(prevPeriodSummaries, empIds.length * prevWorkDays),
  };

  // Top late
  const topLateCountByEmp = new Map<number, number>();
  const avgArrivalByEmp = new Map<number, number>();
  const arrivalCountByEmp = new Map<number, number>();
  for (const s of periodSummaries) {
    if (s.first_entry) {
      const [h, m] = s.first_entry.split(':').map(Number);
      const min = h * 60 + m;
      avgArrivalByEmp.set(s.employee_id, (avgArrivalByEmp.get(s.employee_id) || 0) + min);
      arrivalCountByEmp.set(s.employee_id, (arrivalCountByEmp.get(s.employee_id) || 0) + 1);
      if (s.first_entry > SLIGHTLY_LATE_THRESHOLD) {
        topLateCountByEmp.set(s.employee_id, (topLateCountByEmp.get(s.employee_id) || 0) + 1);
      }
    }
  }
  const topLate = [...topLateCountByEmp.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([empId, lateCnt]) => {
      const totalMin = avgArrivalByEmp.get(empId) || 0;
      const cnt = arrivalCountByEmp.get(empId) || 1;
      const avg = Math.round(totalMin / cnt);
      return {
        employee_id: empId,
        full_name: empNameMap.get(empId) || '',
        lateCount: lateCnt,
        avgArrival: `${String(Math.floor(avg / 60)).padStart(2, '0')}:${String(avg % 60).padStart(2, '0')}`,
      };
    });

  // Period stats
  let periodStats: IDashboardStatsResult['periodStats'] = null;
  if (period === 'week' || period === 'month') {
    const datesPresent = new Set(periodSummaries.filter(s => s.first_entry).map(s => s.date));
    const pWorkDays = datesPresent.size || 1;

    const dailyPresent = new Map<string, number>();
    for (const s of periodSummaries) {
      if (s.is_present) dailyPresent.set(s.date, (dailyPresent.get(s.date) || 0) + 1);
    }
    const totalPresent = [...dailyPresent.values()].reduce((a, b) => a + b, 0);
    const avgPresent = Math.round(totalPresent / pWorkDays);
    const avgAbsent = Math.max(0, empIds.length - avgPresent);

    const pExpectedTotal = empIds.length * pWorkDays;
    const attendanceRate = pExpectedTotal > 0 ? Math.round((totalPresent / pExpectedTotal) * 100) : 0;

    const pLateCount = periodSummaries.filter(s => s.first_entry && s.first_entry > LATE_THRESHOLD).length;
    const prevLateCount = prevPeriodSummaries.filter(s => s.first_entry && s.first_entry > LATE_THRESHOLD).length;

    periodStats = { avgPresent, avgAbsent, attendanceRate, lateCount: pLateCount, prevLateCount };
  }

  // Early leave today
  const todaySummaries = (summaries || []).filter(s => s.date === todayStr);
  const earlyLeaveToday = todaySummaries.filter(
    s => s.is_present && s.last_exit && s.last_exit < '17:00:00'
  ).length;

  // Today entries/exits count
  const todayEntriesCount = (todayEvents || []).length;
  const todayExitsCount = (todayExitEvents || []).length;

  // Recent events
  const recentEvents = (recentEventsRaw || []).map(ev => ({
    time: ev.event_time ? ev.event_time.slice(0, 5) : '',
    name: ev.employee_id ? (empNameMap.get(ev.employee_id) || ev.physical_person || 'Неизвестный') : (ev.physical_person || 'Неизвестный'),
    accessPoint: ev.access_point || '',
    direction: ev.direction as 'entry' | 'exit' | null,
  }));

  // Anomalies
  const refusals = (unknownEvents || []).length;
  const entryCountByEmp = new Map<number, number>();
  for (const ev of todayEvents || []) {
    if (ev.employee_id) {
      entryCountByEmp.set(ev.employee_id, (entryCountByEmp.get(ev.employee_id) || 0) + 1);
    }
  }
  let multipleEntry = 0;
  for (const [, count] of entryCountByEmp) {
    if (count > 2) multipleEntry++;
  }
  const anomalies = { refusals, multipleEntry };

  return {
    lateToday, lateYesterday, punctuality, avgArrivalByDay, risks,
    hourlyActivity, weekComparison, topLate, periodStats,
    earlyLeaveToday, recentEvents, anomalies,
    todayEntriesCount, todayExitsCount,
  };
}
