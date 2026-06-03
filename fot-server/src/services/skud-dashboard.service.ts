/**
 * СКУД: логика дашборда руководителя (GET /api/skud/dashboard-stats).
 */
import { query } from '../config/postgres.js';
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

type DashboardTodayCounts = {
  entry_count: number;
  exit_count: number;
  exit_distinct_emp: number;
};

const dashboardCache = new Map<string, { data: IDashboardStatsResult; expiresAt: number }>();
const DASHBOARD_TTL_MS = 60_000;

export function invalidateDashboardCache(): void {
  dashboardCache.clear();
}

/**
 * Инициализация skud_daily_summary при старте сервера.
 * Если таблица пуста, но есть события в skud_events — заполняет её.
 * Вызывается один раз при старте, перед запуском presence-polling.
 */
export async function initializeSKUDDailySummaryOnStartup(): Promise<void> {
  console.log('[skud-dashboard] начало инициализации skud_daily_summary...');
  try {
    // Проверяем, пуста ли таблица
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM skud_daily_summary',
    );
    const count = countResult?.[0]?.count ?? '0';
    const summaryCount = parseInt(count, 10);

    console.log('[skud-dashboard] текущий размер skud_daily_summary:', summaryCount);

    if (summaryCount > 0) {
      console.log(`[skud-dashboard] skud_daily_summary уже заполнена (${summaryCount} записей) — инициализация пропущена`);
      return;
    }

    // Если таблица пуста, но есть события — пересчитываем
    const eventCountResult = await query<{ event_count: string }>(
      'SELECT COUNT(*) as event_count FROM skud_events WHERE event_date >= NOW() - INTERVAL \'90 days\'',
    );
    const event_count = eventCountResult?.[0]?.event_count ?? '0';
    const eventCount = parseInt(event_count, 10);

    console.log('[skud-dashboard] событий в skud_events за 90 дней:', eventCount);

    if (eventCount === 0) {
      console.log('[skud-dashboard] skud_daily_summary пуста и нет событий для инициализации');
      return;
    }

    // Собираем все уникальные пары (emp_id, date) за 90 дней
    const pairs = await query<{ emp_id: number; date: string }>(
      `SELECT DISTINCT employee_id as emp_id, event_date::date as date
       FROM skud_events
       WHERE employee_id IS NOT NULL
         AND event_date >= NOW() - INTERVAL '90 days'
       ORDER BY date DESC, emp_id ASC`,
    );

    console.log('[skud-dashboard] найдено уникальных (emp_id, date) пар:', pairs?.length ?? 0);

    if (!pairs || pairs.length === 0) {
      console.log('[skud-dashboard] Нет привязанных событий для инициализации');
      return;
    }

    // Пересчитываем батчами
    const BATCH_SIZE = 200;
    console.log(`[skud-dashboard] начинаю пересчет ${pairs.length} пар батчами по ${BATCH_SIZE}...`);
    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
      const batch = pairs.slice(i, i + BATCH_SIZE);
      console.log(`[skud-dashboard] обработка батча ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pairs.length / BATCH_SIZE)}`);
      await query(
        'SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)',
        [JSON.stringify(batch)],
      );
    }

    console.log(`[skud-dashboard] ✓ инициализирована skud_daily_summary: ${pairs.length} пар пересчитано`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[skud-dashboard] ✗ ошибка инициализации skud_daily_summary: ${message}`);
    if (err instanceof Error) console.error(err.stack);
    // Не падаем — это некритичная инициализация
  }
}

async function loadAttendanceHoursMap(params: {
  employees: IAttendanceEmployee[];
  startDate: string;
  endDate: string;
  todayStr: string;
  showActualHours: boolean;
}): Promise<Map<number, Map<string, number>>> {
  const { employees, startDate, endDate, todayStr, showActualHours } = params;
  const result = new Map<number, Map<string, number>>();
  if (employees.length === 0 || startDate > endDate) return result;

  const dailySchedulesMap = await resolveSchedulesForPeriod(
    employees.map(e => ({ id: e.id })),
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

  const displayMode: 'actual' | 'capped_to_schedule' = showActualHours ? 'actual' : 'capped_to_schedule';

  await Promise.all(months.map(async (m) => {
    const calendarMonth = await loadCalendarMonth(m.year, m.month);
    const { entries } = await buildAttendanceEntries({
      employees,
      startDate: m.rangeStart,
      endDate: m.rangeEnd,
      dailySchedulesMap,
      calendarMonth,
      todayStr,
      displayMode,
    });
    for (const entry of entries) {
      const hours = showActualHours
        ? (entry.hours_worked ?? entry.display_hours_worked ?? 0)
        : (entry.display_hours_worked ?? entry.hours_worked ?? 0);
      if (!result.has(entry.employee_id)) {
        result.set(entry.employee_id, new Map());
      }
      result.get(entry.employee_id)!.set(entry.work_date, hours);
    }
  }));

  return result;
}

// Раньше эти выборки делались постранично (LIMIT 1000 OFFSET n в цикле):
// большой OFFSET в Postgres сканирует и отбрасывает все предыдущие строки —
// O(n²) на масштабе. Один запрос с тем же WHERE/ORDER BY даёт идентичный
// упорядоченный набор за один проход (паритет: конкатенация страниц == полный
// упорядоченный результат).
async function fetchSummaryRows(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<DashboardSummaryRow[]> {
  if (employeeIds.length === 0) return [];
  return query<DashboardSummaryRow>(
    `SELECT employee_id, date, first_entry, last_exit, total_hours, is_present
     FROM skud_daily_summary
     WHERE employee_id = ANY($1::bigint[]) AND date >= $2 AND date <= $3
     ORDER BY date ASC, employee_id ASC`,
    [employeeIds, startDate, endDate],
  );
}

async function fetchEntryEventRows(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<DashboardEventRow[]> {
  if (employeeIds.length === 0) return [];
  return query<DashboardEventRow>(
    `SELECT event_date, event_time, employee_id FROM skud_events
     WHERE direction = 'entry' AND employee_id = ANY($1::bigint[])
       AND event_date >= $2 AND event_date <= $3
     ORDER BY event_date ASC, employee_id ASC, event_time ASC`,
    [employeeIds, startDate, endDate],
  );
}

// Раньше тянулись ВСЕ сегодняшние события входа/выхода только ради .length и
// Set(employee_id). Теперь — агрегатный запрос (счётчики считает СУБД).
// Паритет: COUNT(*) == rows.length; COUNT(DISTINCT employee_id) == Set.size.
async function fetchTodayEventCounts(
  employeeIds: number[],
  date: string,
): Promise<DashboardTodayCounts> {
  if (employeeIds.length === 0) {
    return { entry_count: 0, exit_count: 0, exit_distinct_emp: 0 };
  }
  const rows = await query<DashboardTodayCounts>(
    `SELECT
       COUNT(*) FILTER (WHERE direction = 'entry')::int AS entry_count,
       COUNT(*) FILTER (WHERE direction = 'exit')::int AS exit_count,
       COUNT(DISTINCT employee_id) FILTER (WHERE direction = 'exit')::int AS exit_distinct_emp
     FROM skud_events
     WHERE event_date = $1 AND employee_id = ANY($2::bigint[])
       AND direction IN ('entry', 'exit')`,
    [date, employeeIds],
  );
  const r = rows?.[0];
  return {
    entry_count: Number(r?.entry_count) || 0,
    exit_count: Number(r?.exit_count) || 0,
    exit_distinct_emp: Number(r?.exit_distinct_emp) || 0,
  };
}

export async function getDashboardStats(
  params: IDashboardStatsParams,
): Promise<IDashboardStatsResult> {
  const { departmentId, period, month, showActualHours, force, allowedEmployeeIds } = params;

  // Ключ кэша учитывает объектный фильтр (иначе два руководителя с одним отделом,
  // но разными объектами получили бы общий закэшированный результат).
  const allowedKey = allowedEmployeeIds && allowedEmployeeIds.size > 0
    ? `emp:${[...allowedEmployeeIds].sort((a, b) => a - b).join(',')}`
    : 'all-emp';
  const cacheKey = `${departmentId ?? 'all'}|${period ?? 'default'}|${month ?? 'current'}|${showActualHours ? 'actual' : 'capped'}|${allowedKey}`;
  if (!force) {
    const cached = dashboardCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  const deptIds = await collectDeptIds(departmentId);

  console.log('[getDashboardStats] deptIds:', deptIds);

  // Диагностика: загружаем ВСЕ сотрудников отдела (без фильтров), чтобы видеть статус
  const allDeptEmployees = await query<{ id: number; full_name: string | null; employment_status: string; is_archived: boolean }>(
    `SELECT id, full_name, employment_status, is_archived FROM employees
     WHERE org_department_id = ANY($1::uuid[])
     LIMIT 20`,
    [deptIds],
  );
  console.log('[getDashboardStats] all employees in deptIds (diagnostic)', {
    totalCount: allDeptEmployees?.length ?? 0,
    sample: allDeptEmployees?.slice(0, 5),
  });

  const [employeesRaw, internalPoints] = await Promise.all([
    query<{ id: number; full_name: string | null; org_department_id: string | null }>(
      `SELECT id, full_name, org_department_id FROM employees
       WHERE is_archived = false AND employment_status = 'active'
         AND org_department_id = ANY($1::uuid[])`,
      [deptIds],
    ),
    getInternalAccessPoints(),
  ]);

  // Объектный view-скоуп: оставляем только сотрудников из видимого набора.
  const employees = (allowedEmployeeIds && allowedEmployeeIds.size > 0)
    ? employeesRaw.filter(e => allowedEmployeeIds.has(Number(e.id)))
    : employeesRaw;

  console.log('[getDashboardStats] employee query result', {
    employeeCount: employees?.length ?? 0,
    deptIds,
  });

  if (!employees || employees.length === 0) {
    console.log('[getDashboardStats] No active employees found', {
      deptIds,
      period,
      month,
      employeesLength: employees?.length ?? 0,
      employeesData: employees,
    });
    const empty: IDashboardStatsResult = {
      lateToday: 0, lateYesterday: 0,
      punctuality: { onTime: 0, slightlyLate: 0, veryLate: 0, absent: 0 },
      avgArrivalByDay: [], risks: [],
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

  const empListForSched = employees.map(e => ({ id: e.id as number }));
  const schedulesMap = await resolveSchedulesBulk(empListForSched, formatDateToISO(new Date()));

  const today = new Date();
  const todayStr = formatDateToISO(today);
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

  let targetMonthYear = today.getFullYear();
  let targetMonthIdx = today.getMonth();
  if (period === 'month' && month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    targetMonthYear = y;
    targetMonthIdx = m - 1;
  }
  const monthStart = new Date(targetMonthYear, targetMonthIdx, 1);
  const monthEnd = new Date(targetMonthYear, targetMonthIdx + 1, 0);
  const monthStartStr = formatDateToISO(monthStart);
  const isCurrentMonth = targetMonthYear === today.getFullYear() && targetMonthIdx === today.getMonth();
  const monthEndStr = isCurrentMonth ? todayStr : formatDateToISO(monthEnd);
  const prevMonthStart = new Date(targetMonthYear, targetMonthIdx - 1, 1);
  const prevMonthEnd = new Date(targetMonthYear, targetMonthIdx, 0);
  const prevMonthStartStr = formatDateToISO(prevMonthStart);
  const prevMonthEndStr = formatDateToISO(prevMonthEnd);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  while (yesterday.getDay() === 0 || yesterday.getDay() === 6) {
    yesterday.setDate(yesterday.getDate() - 1);
  }
  const yesterdayStr = formatDateToISO(yesterday);

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

  // Для месячной/недельной статистики проверяем СКУД на начало периода, не на сегодня.
  // Если сегодня выходной, но есть рабочие дни в месяце/неделе — сотрудники не должны быть удаленными.
  const checkDateForSkud = period === 'today' ? today : new Date(periodStartStr + 'T00:00:00');
  const remoteEmpIds = new Set<number>();
  for (const [empId, sched] of schedulesMap) {
    if (!needsSkudCheck(sched, checkDateForSkud)) remoteEmpIds.add(empId);
  }
  const officeEmpIds = empIds.filter(id => !remoteEmpIds.has(id));

  const summaryStartDate = period === 'month' ? prevPeriodStartStr : period === 'week' ? prevWeekStartStr : yesterdayStr;
  const summaryEndDate = period === 'month' && !isCurrentMonth ? periodEndStr : todayStr;

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
    ? fetchEntryEventRows(empIds, periodStartStr, periodEndStr)
    : Promise.resolve([] as DashboardEventRow[]);
  const arrivalEventsPromise = canReusePeriodEventsForArrival
    ? periodEventsPromise
    : fetchEntryEventRows(empIds, arrivalRangeStart, arrivalRangeEnd);

  const attendanceEmployees: IAttendanceEmployee[] = employees.map(e => ({
    id: e.id as number,
    full_name: (e.full_name as string | null) || null,
  }));

  console.log('[getDashboardStats] loading data', {
    period,
    deptIds,
    empIds,
    empCount: empIds.length,
    summaryStartDate,
    summaryEndDate,
  });

  const [summaries, todayCounts, recentEventsRaw, periodEvents, arrivalEvents, attendanceHoursMap] = await Promise.all([
    fetchSummaryRows(empIds, summaryStartDate, summaryEndDate),
    fetchTodayEventCounts(empIds, todayStr),
    query<{
      event_time: string;
      employee_id: number | null;
      physical_person: string | null;
      access_point: string | null;
      direction: 'entry' | 'exit' | null;
    }>(
      `SELECT event_time, employee_id, physical_person, access_point, direction
       FROM skud_events
       WHERE event_date = $1 AND employee_id = ANY($2::bigint[])
       ORDER BY event_time DESC
       LIMIT 50`,
      [todayStr, empIds],
    ),
    periodEventsPromise,
    arrivalEventsPromise,
    loadAttendanceHoursMap({
      employees: attendanceEmployees,
      startDate: summaryStartDate,
      endDate: summaryEndDate,
      todayStr,
      showActualHours,
    }),
  ]);

  console.log('[getDashboardStats] data loaded', {
    summariesCount: summaries?.length ?? 0,
    todayCounts: { ...todayCounts },
    recentEventsCount: recentEventsRaw?.length ?? 0,
    periodEventsCount: periodEvents?.length ?? 0,
    arrivalEventsCount: arrivalEvents?.length ?? 0,
  });

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

  let lateToday = 0;
  let lateYesterday = 0;
  for (const s of summaries || []) {
    if (!s.first_entry) continue;
    if (remoteEmpIds.has(s.employee_id)) continue;
    const threshold = getLateThresholdFor(s.employee_id, s.date);
    if (s.date === todayStr && s.first_entry > threshold) lateToday++;
    if (s.date === yesterdayStr && s.first_entry > threshold) lateYesterday++;
  }

  const periodSummaries = (summaries || []).filter(s => s.date >= periodStartStr && s.date <= periodEndStr);
  const prevPeriodSummaries = (summaries || []).filter(s => s.date >= prevPeriodStartStr && s.date <= prevPeriodEndStr);

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

  const totalArrived = periodWithEntry.length || 1;
  const punctuality = {
    onTime: Math.round((onTimeCount / totalArrived) * 100),
    slightlyLate: Math.round((slightlyLateCount / totalArrived) * 100),
    veryLate: Math.round((veryLateCount / totalArrived) * 100),
    absent: 0,
  };

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

  let periodStats: IDashboardStatsResult['periodStats'] = null;
  if (period === 'week' || period === 'month') {
    const pWorkDays = actualWorkDays;

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
      todayEntryEventsLoaded: todayCounts.entry_count,
      todayExitEventsLoaded: todayCounts.exit_count,
      totalPresent,
      avgPresent,
      dailyBreakdown: [...dailyPresent.entries()].map(([d, s]) => `${d}:${s.size}`),
    });

    const pLateCount = periodSummaries.filter(s => s.first_entry && !remoteEmpIds.has(s.employee_id) && s.first_entry > getLateThresholdFor(s.employee_id, s.date)).length;
    const prevLateCount = prevPeriodSummaries.filter(s => s.first_entry && !remoteEmpIds.has(s.employee_id) && s.first_entry > getLateThresholdFor(s.employee_id, s.date)).length;

    periodStats = { avgPresent, avgAbsent, attendanceRate, lateCount: pLateCount, prevLateCount };
  }

  // earlyLeaveToday = число уникальных сотрудников с выходом сегодня
  // (раньше — Set по выгруженным строкам выхода).
  const earlyLeaveToday = todayCounts.exit_distinct_emp;

  const todayEntriesCount = todayCounts.entry_count;
  const todayExitsCount = todayCounts.exit_count;

  const recentEvents = (recentEventsRaw || []).map(ev => ({
    time: ev.event_time ? ev.event_time.slice(0, 5) : '',
    name: ev.employee_id ? (empNameMap.get(ev.employee_id) || ev.physical_person || 'Неизвестный') : (ev.physical_person || 'Неизвестный'),
    accessPoint: ev.access_point || '',
    direction: ev.direction as 'entry' | 'exit' | null,
    isInternal: internalPoints.size > 0 && !!ev.access_point && internalPoints.has(ev.access_point.trim()),
  }));

  const result: IDashboardStatsResult = {
    lateToday, lateYesterday, punctuality, avgArrivalByDay, risks,
    weekComparison, topLate, periodStats,
    earlyLeaveToday, recentEvents,
    todayEntriesCount, todayExitsCount,
  };

  dashboardCache.set(cacheKey, { data: result, expiresAt: Date.now() + DASHBOARD_TTL_MS });
  return result;
}
