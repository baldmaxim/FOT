import { Response } from 'express';
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { sigurService } from '../services/sigur.service.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { computeDedupHash } from '../utils/dedup.utils.js';
import { parseDate, formatDateToISO } from '../utils/date.utils.js';
import { getOrgId } from '../utils/org.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

interface SkudEventRow {
  organization_id: string;
  physical_person: string;
  card_number: string | null;
  event_date: string;
  event_time: string;
  access_point: string | null;
  direction: 'entry' | 'exit' | null;
  employee_id: number | null;
  dedup_hash: string;
}

interface DailySummaryRow {
  id: number;
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
}

/** Запрос событий по employee_id */
async function queryEventsByEmployeeId(
  employeeId: number,
  orgId: string | undefined,
  startDate: unknown,
  endDate: unknown,
) {
  let query = supabase
    .from('skud_events')
    .select('*')
    .eq('employee_id', employeeId)
    .order('event_date', { ascending: false })
    .order('event_time', { ascending: false })
    .limit(5000);

  if (orgId) query = query.eq('organization_id', orgId);
  if (startDate && typeof startDate === 'string') query = query.gte('event_date', startDate);
  if (endDate && typeof endDate === 'string') query = query.lte('event_date', endDate);

  const { data } = await query;
  return data || [];
}

/** Пагинированный поиск по ФИО + бэкфилл employee_id */
async function searchAndBackfillByName(
  employeeId: number,
  employeeName: string,
  orgId: string,
  startDate: unknown,
  endDate: unknown,
) {
  const PAGE_SIZE = 1000;
  const MAX_SCAN = 50000;
  let offset = 0;
  const matched: Record<string, unknown>[] = [];
  const idsToBackfill: number[] = [];

  while (offset < MAX_SCAN) {
    let query = supabase
      .from('skud_events')
      .select('*')
      .eq('organization_id', orgId)
      .is('employee_id', null)
      .range(offset, offset + PAGE_SIZE - 1);

    if (startDate && typeof startDate === 'string') query = query.gte('event_date', startDate);
    if (endDate && typeof endDate === 'string') query = query.lte('event_date', endDate);

    const { data: page } = await query;
    if (!page || page.length === 0) break;

    for (const ev of page) {
      const name = (ev.physical_person || '').toLowerCase().trim();
      if (name === employeeName) {
        matched.push(ev);
        idsToBackfill.push(ev.id);
      }
    }

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Бэкфилл employee_id на найденные записи (в фоне, пакетный RPC)
  if (idsToBackfill.length > 0) {
    supabase
      .rpc('bulk_update_employee_ids', {
        p_event_ids: idsToBackfill,
        p_employee_ids: idsToBackfill.map(() => employeeId),
      })
      .then(() => {
        console.log(`[employee-events] backfilled employee_id=${employeeId} on ${idsToBackfill.length} events`);
      });
  }

  return matched;
}

/** Собирает ID отдела + все дочерние */
async function collectDeptIds(departmentId: string, organizationId: string | undefined): Promise<string[]> {
  let deptQuery = supabase.from('org_departments').select('id, parent_id');
  if (organizationId) deptQuery = deptQuery.eq('organization_id', organizationId);
  const { data: allDepts } = await deptQuery;

  const ids = [departmentId];
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of allDepts || []) {
      if (d.parent_id && ids.includes(d.parent_id) && !ids.includes(d.id)) {
        ids.push(d.id);
        changed = true;
      }
    }
  }
  return ids;
}

/** Получает ID всех предков отдела (от родителя до корня) */
function getAncestorDeptIds(deptId: string, allDepts: { id: string; parent_id: string | null }[]): string[] {
  const ancestors: string[] = [];
  let currentId: string | null = deptId;
  const visited = new Set<string>([deptId]);
  while (currentId) {
    const dept = allDepts.find(d => d.id === currentId);
    if (dept?.parent_id && !visited.has(dept.parent_id)) {
      ancestors.push(dept.parent_id);
      visited.add(dept.parent_id);
      currentId = dept.parent_id;
    } else {
      break;
    }
  }
  return ancestors;
}

/** Вычисляет понедельник текущей/указанной недели */
function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];

/** Считает рабочие дни (Пн–Пт) между двумя ISO-датами включительно */
function countWorkingDays(startStr: string, endStr: string): number {
  let count = 0;
  const cur = new Date(startStr);
  const end = new Date(endStr);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Загружает ID и имена сотрудников, относящихся к отделам из sync filter.
 * Возвращает null если фильтр не настроен (показывать всё).
 */
async function getSyncFilteredEmployees(
  organizationId: string | undefined,
): Promise<{ empIds: Set<number>; empNames: Set<string> } | null> {
  if (!organizationId) return null;

  // 1. Загружаем whitelist sigur_department_id
  const { data: filterRows } = await supabase
    .from('skud_sync_department_filter')
    .select('sigur_department_id')
    .eq('organization_id', organizationId);

  if (!filterRows || filterRows.length === 0) {
    console.log('[sync-filter] Нет фильтра для org', organizationId, '→ показываем всё');
    return null;
  }

  const sigurDeptIds = filterRows.map(r => r.sigur_department_id);
  console.log('[sync-filter] sigur_department_ids из фильтра:', sigurDeptIds);

  // 2. Маппим sigur_department_id → org_departments.id
  const { data: depts } = await supabase
    .from('org_departments')
    .select('id, parent_id, name, sigur_department_id')
    .eq('organization_id', organizationId)
    .in('sigur_department_id', sigurDeptIds);

  console.log('[sync-filter] Найдено отделов по sigur_id:', depts?.length || 0,
    depts?.map(d => `${d.name} (sigur=${d.sigur_department_id})`));

  if (!depts || depts.length === 0) return { empIds: new Set(), empNames: new Set() };

  // 3. Собираем дочерние отделы
  const { data: allDepts } = await supabase
    .from('org_departments')
    .select('id, parent_id')
    .eq('organization_id', organizationId);

  const deptIds = new Set(depts.map(d => d.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of allDepts || []) {
      if (d.parent_id && deptIds.has(d.parent_id) && !deptIds.has(d.id)) {
        deptIds.add(d.id);
        changed = true;
      }
    }
  }
  console.log('[sync-filter] Итого отделов (с дочерними):', deptIds.size);

  // 4. Загружаем сотрудников из этих отделов
  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .eq('is_archived', false)
    .in('org_department_id', [...deptIds]);

  const empIds = new Set<number>();
  const empNames = new Set<string>();
  for (const e of employees || []) {
    empIds.add(e.id);
    if (e.full_name) empNames.add(e.full_name.toLowerCase().trim());
  }

  console.log('[sync-filter] Найдено сотрудников:', empIds.size);

  return { empIds, empNames };
}

// Кэш access points (TTL 10 минут)
const AP_CACHE_TTL = 10 * 60_000;
const accessPointCache = new Map<string, { data: string[]; at: number }>();

export const skudController = {
  /**
   * GET /api/skud/dashboard-stats?department_id=uuid&period=today|week|month
   * Агрегированная аналитика для дашборда руководителя
   */
  async getDashboardStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const departmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;
      const period = (req.query.period as string) || 'today';

      if (!departmentId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }

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
        res.json({ success: true, data: { lateToday: 0, lateYesterday: 0, punctuality: { onTime: 0, slightlyLate: 0, veryLate: 0, absent: 0 }, avgArrivalByDay: [], risks: [], hourlyActivity: [], weekComparison: null, topLate: [], periodStats: null, earlyLeaveToday: 0, recentEvents: [], anomalies: { refusals: 0, multipleEntry: 0 }, todayEntriesCount: 0, todayExitsCount: 0 } });
        return;
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

      // Даты для месяца
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const monthStartStr = formatDateToISO(monthStart);
      const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
      const prevMonthStartStr = formatDateToISO(prevMonthStart);
      const prevMonthEndStr = formatDateToISO(prevMonthEnd);

      // Вчера (рабочий день — пропускаем выходные)
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
        // today
        periodStartStr = todayStr;
        periodEndStr = todayStr;
        prevPeriodStartStr = yesterdayStr;
        prevPeriodEndStr = yesterdayStr;
      }

      // Определяем начало запроса summaries — покрывает и текущий, и предыдущий периоды
      const summaryStartDate = period === 'month' ? prevMonthStartStr : period === 'week' ? lastMondayStr : yesterdayStr;

      // 4 недели назад (для среднего времени прихода)
      const fourWeeksAgo = new Date(monday);
      fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 21);
      const fourWeeksAgoStr = formatDateToISO(fourWeeksAgo);

      // Запрос daily_summary (диапазон зависит от периода)
      const { data: summaries } = await supabase
        .from('skud_daily_summary')
        .select('employee_id, date, first_entry, last_exit, total_hours, is_present')
        .in('employee_id', empIds)
        .gte('date', summaryStartDate)
        .lte('date', todayStr);

      // Запрос entry-событий за сегодня для hourly activity
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

      // Запрос последних событий для «События в эфире»
      let recentEvQuery = supabase
        .from('skud_events')
        .select('event_time, employee_id, physical_person, access_point, direction')
        .eq('event_date', todayStr)
        .in('employee_id', empIds)
        .order('event_time', { ascending: false })
        .limit(10);
      if (organizationId) recentEvQuery = recentEvQuery.eq('organization_id', organizationId);
      const { data: recentEventsRaw } = await recentEvQuery;

      // Запрос аномалий: события без employee_id (неопознанные)
      let anomalyQuery = supabase
        .from('skud_events')
        .select('id, employee_id, physical_person, direction')
        .eq('event_date', todayStr)
        .is('employee_id', null);
      if (organizationId) anomalyQuery = anomalyQuery.eq('organization_id', organizationId);
      const { data: unknownEvents } = await anomalyQuery;

      // --- Агрегация ---
      const LATE_THRESHOLD = '09:00:00';
      const SLIGHTLY_LATE_THRESHOLD = '09:15:00';

      // Late today / yesterday
      let lateToday = 0;
      let lateYesterday = 0;
      for (const s of summaries || []) {
        if (!s.first_entry) continue;
        if (s.date === todayStr && s.first_entry > LATE_THRESHOLD) lateToday++;
        if (s.date === yesterdayStr && s.first_entry > LATE_THRESHOLD) lateYesterday++;
      }

      // Period summaries (для всех period-aware блоков)
      const periodSummaries = (summaries || []).filter(s => s.date >= periodStartStr && s.date <= periodEndStr);
      const prevPeriodSummaries = (summaries || []).filter(s => s.date >= prevPeriodStartStr && s.date <= prevPeriodEndStr);

      // Punctuality (period-aware)
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

      // Average arrival by weekday (period-aware)
      // today: текущая неделя (Mon-today), будущие дни пусты
      // week: 4 недели (текущее поведение)
      // month: текущий месяц
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

      // Находим первый entry за каждый день для каждого сотрудника
      const firstEntryMap = new Map<string, string>(); // "empId:date" -> event_time
      for (const ev of arrivalEvents || []) {
        const key = `${ev.employee_id}:${ev.event_date}`;
        if (!firstEntryMap.has(key)) firstEntryMap.set(key, ev.event_time);
      }

      // Группируем по дню недели
      const arrivalByDow: number[][] = [[], [], [], [], []];
      // Для today — определяем текущий день недели (0=Пн..4=Пт), дни после сегодня будут пустыми
      const todayDowIdx = today.getDay() === 0 ? 6 : today.getDay() - 1;
      for (const [key, time] of firstEntryMap) {
        const date = key.split(':').slice(1).join(':');
        const d = new Date(date + 'T00:00:00');
        const dow = d.getDay();
        const dowIdx = dow === 0 ? 6 : dow - 1;
        if (dowIdx >= 5) continue;
        // Для today — не включаем дни после сегодня
        if (period === 'today' && dowIdx > todayDowIdx) continue;
        const [h, m] = time.split(':').map(Number);
        arrivalByDow[dowIdx].push(h * 60 + m);
      }
      const avgArrivalByDay = DAY_NAMES.map((name, i) => {
        // Для today — дни после сегодня пусты
        if (period === 'today' && i > todayDowIdx) return { day: name, avgTime: null, date: '', isToday: i === todayDowIdx };
        const times = arrivalByDow[i];
        if (times.length === 0) return { day: name, avgTime: null, date: '', isToday: period === 'today' && i === todayDowIdx };
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        const avgH = String(Math.floor(avg / 60)).padStart(2, '0');
        const avgM = String(avg % 60).padStart(2, '0');
        return { day: name, avgTime: `${avgH}:${avgM}`, date: '', isToday: period === 'today' && i === todayDowIdx };
      });

      // Risks (period-aware)
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
      const risks: { employee_id: number; full_name: string; reason: string; severity: 'high' | 'medium' }[] = [];
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

      // Hourly activity (period-aware)
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
        // Для week/month — запрос entry-событий за весь период
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
        // Усредняем по рабочим дням
        const workDaysCount = actualWorkDays || 1;
        for (const [h, count] of hourlyMap) {
          hourlyMap.set(h, Math.round(count / workDaysCount));
        }
      }
      const hourlyActivity = [...hourlyMap.entries()].map(([hour, count]) => ({ hour, count }));

      // Period comparison (period-aware)
      const calcWeekMetrics = (weekData: typeof periodSummaries, expectedRecords: number) => {
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

      // Top late (period-aware, только приходы после 09:15)
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
        .map(([empId, lateCount]) => {
          const totalMin = avgArrivalByEmp.get(empId) || 0;
          const cnt = arrivalCountByEmp.get(empId) || 1;
          const avg = Math.round(totalMin / cnt);
          return {
            employee_id: empId,
            full_name: empNameMap.get(empId) || '',
            lateCount,
            avgArrival: `${String(Math.floor(avg / 60)).padStart(2, '0')}:${String(avg % 60).padStart(2, '0')}`,
          };
        });

      // Period stats (period-aware, для карточек статистики по периодам)
      let periodStats: { avgPresent: number; avgAbsent: number; attendanceRate: number; lateCount: number; prevLateCount: number } | null = null;

      if (period === 'week' || period === 'month') {
        // Рабочие дни с присутствием
        const datesPresent = new Set(periodSummaries.filter(s => s.first_entry).map(s => s.date));
        const pWorkDays = datesPresent.size || 1;

        // Средняя явка
        const dailyPresent = new Map<string, number>();
        for (const s of periodSummaries) {
          if (s.is_present) dailyPresent.set(s.date, (dailyPresent.get(s.date) || 0) + 1);
        }
        const totalPresent = [...dailyPresent.values()].reduce((a, b) => a + b, 0);
        const avgPresent = Math.round(totalPresent / pWorkDays);
        const avgAbsent = Math.max(0, empIds.length - avgPresent);

        // Посещаемость
        const pExpectedTotal = empIds.length * pWorkDays;
        const attendanceRate = pExpectedTotal > 0 ? Math.round((totalPresent / pExpectedTotal) * 100) : 0;

        // Опоздания
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

      // Recent events (для «События в эфире»)
      const recentEvents = (recentEventsRaw || []).map(ev => ({
        time: ev.event_time ? ev.event_time.slice(0, 5) : '',
        name: ev.employee_id ? (empNameMap.get(ev.employee_id) || ev.physical_person || 'Неизвестный') : (ev.physical_person || 'Неизвестный'),
        accessPoint: ev.access_point || '',
        direction: ev.direction as 'entry' | 'exit' | null,
      }));

      // Anomalies
      const refusals = (unknownEvents || []).length;
      // Multiple entry: сотрудники с >2 entry за сегодня без exit между
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

      res.json({
        success: true,
        data: {
          lateToday, lateYesterday, punctuality, avgArrivalByDay, risks,
          hourlyActivity, weekComparison, topLate, periodStats,
          earlyLeaveToday, recentEvents, anomalies,
          todayEntriesCount, todayExitsCount,
        },
      });
    } catch (error) {
      console.error('getDashboardStats error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения аналитики дашборда' });
    }
  },

  /**
   * GET /api/skud/daily-summary
   * Получение дневных сводок за месяц
   */
  async getDailySummary(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const { date } = req.query; // YYYY-MM-DD (первый день месяца)

      if (!date || typeof date !== 'string') {
        res.status(400).json({ success: false, error: 'Date parameter required' });
        return;
      }

      // Вычисляем диапазон месяца
      const startDate = new Date(date);
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);

      const startStr = formatDateToISO(startDate);
      const endStr = formatDateToISO(endDate);

      let query = supabase
        .from('skud_daily_summary')
        .select('*')
        .gte('date', startStr)
        .lte('date', endStr)
        .order('date');

      if (organizationId) {
        query = query.eq('organization_id', organizationId);
      }

      // Фильтрация по sync filter (отделы)
      const syncFilter = await getSyncFilteredEmployees(organizationId);
      if (syncFilter) {
        const { empIds: allowedIds } = syncFilter;
        if (allowedIds.size > 0) {
          query = query.in('employee_id', [...allowedIds]);
        } else {
          res.json({ success: true, data: [] });
          return;
        }
      }

      const { data, error } = await query;

      if (error) {
        console.error('Get daily summary error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch daily summary' });
        return;
      }

      res.json({ success: true, data: data || [] });
    } catch (error) {
      console.error('Get daily summary error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch daily summary' });
    }
  },

  /**
   * GET /api/skud/employee-events/:employeeId
   * События СКУД конкретного сотрудника.
   * 1) Ищем по employee_id
   * 2) Всегда дополняем поиском по ФИО (события без employee_id) + бэкфилл
   */
  async getEmployeeEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = parseInt(req.params.employeeId, 10);
      if (isNaN(employeeId)) {
        res.status(400).json({ success: false, error: 'Invalid employeeId' });
        return;
      }

      const { startDate, endDate } = req.query;
      const organizationId = getOrgId(req);

      // Получаем ФИО и organization_id сотрудника
      let empQuery = supabase.from('employees').select('full_name, organization_id').eq('id', employeeId);
      if (organizationId) empQuery = empQuery.eq('organization_id', organizationId);
      const { data: empData } = await empQuery.single();

      const effectiveOrgId = organizationId || empData?.organization_id || undefined;

      // 1) По employee_id
      const byId = await queryEventsByEmployeeId(employeeId, effectiveOrgId, startDate, endDate);
      console.log(`[employee-events] id=${employeeId} byId=${byId.length} orgId=${effectiveOrgId} dates=${startDate}..${endDate}`);

      // 2) Всегда ищем по ФИО (события без employee_id) + бэкфилл
      let byName: Record<string, unknown>[] = [];
      if (empData?.full_name && effectiveOrgId) {
        const employeeName = empData.full_name.toLowerCase().trim();
        console.log(`[employee-events] searching by name: "${employeeName}"`);
        byName = await searchAndBackfillByName(employeeId, employeeName, effectiveOrgId, startDate, endDate);
        console.log(`[employee-events] byName=${byName.length}`);
      } else {
        console.log(`[employee-events] skip name search: empData=${!!empData} orgId=${effectiveOrgId}`);
      }

      // Объединяем, убирая дубли по id
      const seenIds = new Set(byId.map((e: Record<string, unknown>) => e.id));
      const events = [...byId, ...byName.filter((e: Record<string, unknown>) => !seenIds.has(e.id))];
      console.log(`[employee-events] total=${events.length}`);

      // Расшифровываем для ответа
      const result = events.map((event: Record<string, unknown>) => ({
        id: event.id,
        physical_person: event.physical_person,
        card_number: event.card_number || null,
        event_date: event.event_date,
        event_time: event.event_time,
        access_point: event.access_point,
        direction: event.direction,
        employee_id: event.employee_id,
      }));

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Get employee events error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch employee events' });
    }
  },

  /**
   * GET /api/skud/events
   * Получение событий СКУД с фильтрами
   */
  async getEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const { startDate, endDate, accessPoint, employeeId, search } = req.query;
      const searchStr = typeof search === 'string' ? search.trim().toLowerCase() : '';

      let query = supabase
        .from('skud_events')
        .select('*')
        .order('event_date', { ascending: false })
        .order('event_time', { ascending: false });

      // Лимит: 1000 для обычного просмотра, 10000 для поиска
      query = query.limit(searchStr ? 10000 : 1000);

      if (organizationId) {
        query = query.eq('organization_id', organizationId);
      }

      if (startDate && typeof startDate === 'string') {
        query = query.gte('event_date', startDate);
      }
      if (endDate && typeof endDate === 'string') {
        query = query.lte('event_date', endDate);
      }
      if (accessPoint && typeof accessPoint === 'string') {
        query = query.eq('access_point', accessPoint);
      }
      if (employeeId && typeof employeeId === 'string') {
        query = query.eq('employee_id', parseInt(employeeId, 10));
      }

      // Фильтрация по sync filter (отделы)
      const syncFilter = await getSyncFilteredEmployees(organizationId);
      if (syncFilter) {
        const { empIds: allowedIds } = syncFilter;
        if (allowedIds.size > 0) {
          query = query.in('employee_id', [...allowedIds]);
        } else {
          res.json({ success: true, data: [] });
          return;
        }
      }

      const { data, error } = await query;

      if (error) {
        console.error('Get events error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch events' });
        return;
      }

      const decrypted = (data || []).map((event: {
        id: number;
        physical_person: string;
        card_number: string | null;
        event_date: string;
        event_time: string;
        access_point: string | null;
        direction: string | null;
        employee_id: number | null;
      }) => ({
        id: event.id,
        physical_person: event.physical_person,
        card_number: event.card_number || null,
        event_date: event.event_date,
        event_time: event.event_time,
        access_point: event.access_point,
        direction: event.direction,
        employee_id: event.employee_id,
      }));

      // Серверный поиск
      const result = searchStr
        ? decrypted.filter(e => (e.physical_person || '').toLowerCase().includes(searchStr))
        : decrypted;

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Get events error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch events' });
    }
  },

  /**
   * GET /api/skud/access-points
   * Получение списка точек доступа из Sigur API (фоллбэк — база)
   */
  async getAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // 1) Попытка получить из Sigur API
      if (sigurService.isConfigured()) {
        try {
          const sigurAPs = await sigurService.getAccessPoints();
          const names = (sigurAPs as Record<string, unknown>[])
            .map(ap => (ap.name as string) || '')
            .filter(Boolean);
          const unique = [...new Set(names)].sort();
          res.json({ success: true, data: unique });
          return;
        } catch (sigurErr) {
          console.warn('Sigur access points fallback to DB:', (sigurErr as Error).message);
        }
      }

      // 2) Фоллбэк: уникальные точки из базы (с кэшем)
      const organizationId = getOrgId(req);
      const cacheKey = organizationId || '__all__';
      const cached = accessPointCache.get(cacheKey);

      if (cached && Date.now() - cached.at < AP_CACHE_TTL) {
        res.json({ success: true, data: cached.data });
        return;
      }

      let query = supabase
        .from('skud_events')
        .select('access_point')
        .not('access_point', 'is', null)
        .limit(5000);

      if (organizationId) {
        query = query.eq('organization_id', organizationId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Get access points error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch access points' });
        return;
      }

      const unique = [...new Set((data || []).map((d: { access_point: string }) => d.access_point))].sort();
      accessPointCache.set(cacheKey, { data: unique, at: Date.now() });

      res.json({ success: true, data: unique });
    } catch (error) {
      console.error('Get access points error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch access points' });
    }
  },

  /**
   * POST /api/skud/import
   * Импорт событий СКУД из Excel
   * Формат колонок:
   * 0 - Сотрудник (ФИО)
   * 1 - пропускаем
   * 2 - Подразделение (пропускаем)
   * 3 - Дата
   * 4 - Дата и Время (извлекаем время)
   * 5 - Помещение (пропускаем)
   * 6 - Карта
   * 7 - Контроллер (точка доступа)
   * 8 - Дверь (1 = вход, иначе = выход)
   * 9 - пропускаем
   */
  async import(req: MulterRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      // Загружаем сотрудников для сопоставления по ФИО
      const { data: employeesData } = await supabase
        .from('employees')
        .select('id, full_name')
        .eq('organization_id', organizationId)
        .eq('is_archived', false);

      const employeeMap = new Map<string, number>();
      for (const emp of employeesData || []) {
        const name = (emp.full_name || '').toLowerCase().trim();
        employeeMap.set(name, emp.id);
      }

      // Парсим Excel
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      const rows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        dateNF: 'yyyy-mm-dd',
      });

      if (rows.length === 0) {
        res.status(400).json({ success: false, error: 'Файл пуст' });
        return;
      }

      // Пропускаем заголовок
      const startRow = isHeaderRow(rows[0]) ? 1 : 0;
      const dataRows = rows.slice(startRow);

      const errors: string[] = [];
      const eventsToInsert: SkudEventRow[] = [];
      const summariesToUpdate = new Set<string>(); // employee_id:date
      const seenHashes = new Set<string>(); // дедупликация внутри файла

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const rowNum = startRow + i + 1;

        if (!row || row.length === 0 || !row[0]) continue;

        // Парсинг колонок по новому формату
        const physicalPerson = String(row[0] || '').trim();        // Сотрудник (ФИО)
        const dateRaw = row[3];                                      // Дата
        const dateTimeRaw = row[4];                                  // Дата и Время
        const cardNumber = String(row[6] || '').trim() || null;      // Карта
        const accessPoint = String(row[7] || '').trim() || null;     // Контроллер
        const doorRaw = String(row[8] || '').trim();                 // Дверь (1 = вход)

        if (!physicalPerson) {
          errors.push(`Строка ${rowNum}: отсутствует ФИО`);
          continue;
        }

        // Парсим дату из колонки 3
        const eventDate = parseDate(dateRaw);
        if (!eventDate) {
          errors.push(`Строка ${rowNum}: некорректная дата`);
          continue;
        }

        // Парсим время из колонки 4 (Дата и Время)
        const eventTime = parseTimeFromDateTime(dateTimeRaw);
        if (!eventTime) {
          errors.push(`Строка ${rowNum}: некорректное время`);
          continue;
        }

        // Определяем направление: 1 = вход, иначе = выход
        const direction: 'entry' | 'exit' =
          (doorRaw === '1' || doorRaw.toLowerCase() === 'вход') ? 'entry' : 'exit';

        // Дедупликация
        const dedupHash = computeDedupHash(physicalPerson, eventDate, eventTime, accessPoint, direction);
        if (seenHashes.has(dedupHash)) continue;
        seenHashes.add(dedupHash);

        // Сопоставляем с сотрудником
        const employeeId = employeeMap.get(physicalPerson.toLowerCase()) || null;

        eventsToInsert.push({
          organization_id: organizationId,
          physical_person: physicalPerson,
          card_number: cardNumber,
          event_date: eventDate,
          event_time: eventTime,
          access_point: accessPoint,
          direction,
          employee_id: employeeId,
          dedup_hash: dedupHash,
        });

        // Отмечаем для пересчёта сводки
        if (employeeId) {
          summariesToUpdate.add(`${employeeId}:${eventDate}`);
        }
      }

      if (eventsToInsert.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Нет данных для импорта',
          errors,
        });
        return;
      }

      // Вставляем события (ON CONFLICT DO NOTHING для защиты от дублей с существующими)
      const { error: insertError } = await supabase
        .from('skud_events')
        .upsert(eventsToInsert, { onConflict: 'dedup_hash', ignoreDuplicates: true });

      if (insertError) {
        console.error('Import insert error:', insertError);
        res.status(500).json({ success: false, error: 'Ошибка сохранения данных' });
        return;
      }

      // Пересчитываем дневные сводки (пакетный RPC)
      if (summariesToUpdate.size > 0) {
        const pairs = [...summariesToUpdate].map(key => {
          const [empId, date] = key.split(':');
          return { org_id: organizationId, emp_id: parseInt(empId, 10), date };
        });
        await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
      }

      await auditService.logFromRequest(req, req.user.id, 'IMPORT_SKUD', {
        details: {
          imported: eventsToInsert.length,
          errors: errors.length,
          matched_employees: [...summariesToUpdate].length,
        },
      });

      res.json({
        success: true,
        data: {
          imported: eventsToInsert.length,
          matched: [...summariesToUpdate].length,
          errors,
        },
      });
    } catch (error) {
      console.error('Import SKUD error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта' });
    }
  },

  /**
   * GET /api/skud/presence
   * Текущий статус присутствия сотрудников (онлайн/оффлайн)
   */
  async getPresence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);

      const departmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;

      // Загружаем все отделы (для дочерних + наследования настроек предков)
      let allDeptsQuery = supabase.from('org_departments').select('id, parent_id');
      if (organizationId) allDeptsQuery = allDeptsQuery.eq('organization_id', organizationId);
      const { data: allDeptsData } = await allDeptsQuery;
      const allDepts = allDeptsData || [];

      // Собираем ID отдела + все дочерние
      let deptIds: string[] | null = null;
      if (departmentId) {
        deptIds = [departmentId];
        let changed = true;
        while (changed) {
          changed = false;
          for (const d of allDepts) {
            if (d.parent_id && deptIds.includes(d.parent_id) && !deptIds.includes(d.id)) {
              deptIds.push(d.id);
              changed = true;
            }
          }
        }
      }

      // Загружаем сотрудников
      let empQuery = supabase
        .from('employees')
        .select('id, full_name, org_department_id, position_id')
        .eq('is_archived', false)
        .eq('employment_status', 'active');

      if (organizationId) {
        empQuery = empQuery.eq('organization_id', organizationId);
      }
      if (deptIds) {
        empQuery = empQuery.in('org_department_id', deptIds);
      }

      const { data: employees } = await empQuery;
      if (!employees || employees.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      const empIds = employees.map(e => e.id);

      // Загружаем справочники
      const deptIdSet = new Set(employees.map(e => e.org_department_id).filter(Boolean));
      const posIdSet = new Set(employees.map(e => e.position_id).filter(Boolean));

      const [deptResult, posResult] = await Promise.all([
        deptIdSet.size > 0
          ? supabase.from('org_departments').select('id, name').in('id', [...deptIdSet])
          : { data: [] },
        posIdSet.size > 0
          ? supabase.from('positions').select('id, name').in('id', [...posIdSet])
          : { data: [] },
      ]);

      const deptMap = new Map<string, string>();
      for (const d of deptResult.data || []) {
        deptMap.set(d.id, d.name || '');
      }
      const posMap = new Map<string, string>();
      for (const p of posResult.data || []) {
        posMap.set(p.id, p.name || '');
      }

      // Загружаем все внутренние точки доступа организации (глобально, без фильтра по отделу)
      let settingsQuery = supabase
        .from('skud_access_point_settings')
        .select('access_point_name')
        .eq('is_internal', true);

      if (organizationId) {
        settingsQuery = settingsQuery.eq('organization_id', organizationId);
      }

      const { data: apSettings } = await settingsQuery;
      const orgInternalPoints = new Set<string>(
        (apSettings || []).map(s => s.access_point_name.trim()),
      );

      // Загружаем события за сегодня (локальная дата, не UTC)
      const today = formatDateToISO(new Date());

      // Карта ФИО → employee.id для фоллбэка
      const nameToEmpId = new Map<string, number>();
      for (const emp of employees) {
        const name = (emp.full_name || '').toLowerCase().trim();
        nameToEmpId.set(name, emp.id);
      }

      // 1) Быстрый запрос по employee_id
      const { data: eventsByEmpId } = await supabase
        .from('skud_events')
        .select('employee_id, event_time, direction, access_point')
        .eq('event_date', today)
        .in('employee_id', empIds)
        .order('event_time', { ascending: false });

      const latestEvent = new Map<number, { event_time: string; direction: string | null }>();
      // Собираем ВСЕ внешние события по сотруднику (ASC для расчёта выходов)
      const allExternalEvents = new Map<number, Array<{ event_time: string; direction: string | null }>>();

      for (const evt of eventsByEmpId || []) {
        if (!evt.employee_id) continue;
        // Пропускаем события от внутренних точек доступа
        if (orgInternalPoints.size > 0 && evt.access_point && orgInternalPoints.has(evt.access_point)) continue;

        if (!latestEvent.has(evt.employee_id)) {
          latestEvent.set(evt.employee_id, { event_time: evt.event_time, direction: evt.direction });
        }
        if (!allExternalEvents.has(evt.employee_id)) {
          allExternalEvents.set(evt.employee_id, []);
        }
        allExternalEvents.get(evt.employee_id)!.push({ event_time: evt.event_time, direction: evt.direction });
      }

      // eventsByEmpId отсортирован DESC — переворачиваем массивы в ASC
      for (const events of allExternalEvents.values()) {
        events.reverse();
      }

      // 2) Фоллбэк: если есть сотрудники без событий — ищем по ФИО
      const missingEmpIds = empIds.filter(id => !latestEvent.has(id));
      if (missingEmpIds.length > 0) {
        let fallbackQuery = supabase
          .from('skud_events')
          .select('physical_person, event_time, direction, access_point, id')
          .eq('event_date', today)
          .is('employee_id', null)
          .order('event_time', { ascending: false });

        if (organizationId) {
          fallbackQuery = fallbackQuery.eq('organization_id', organizationId);
        }

        const { data: unmatchedEvents } = await fallbackQuery;

        // Диагностика
        const unmatchedNames = new Set<string>();

        const backfillPairs: { eventId: number; employeeId: number }[] = [];

        for (const evt of unmatchedEvents || []) {
          const evtName = (evt.physical_person || '').toLowerCase().trim();
          const empId = nameToEmpId.get(evtName);
          if (!empId) {
            unmatchedNames.add(evtName);
            continue;
          }

          // Пропускаем события от внутренних точек доступа
          const isInternal = !!(orgInternalPoints.size > 0 && evt.access_point && orgInternalPoints.has(evt.access_point));

          if (!isInternal) {
            if (!latestEvent.has(empId)) {
              latestEvent.set(empId, { event_time: evt.event_time, direction: evt.direction });
            }
            if (!allExternalEvents.has(empId)) {
              allExternalEvents.set(empId, []);
            }
            allExternalEvents.get(empId)!.push({ event_time: evt.event_time, direction: evt.direction });
          }
          backfillPairs.push({ eventId: evt.id, employeeId: empId });
        }

        console.log(`[getPresence] date=${today}, empById=${(eventsByEmpId || []).length}, unmatchedEvts=${(unmatchedEvents || []).length}, matchedByName=${backfillPairs.length}, noMatch=${unmatchedNames.size}, missing=${missingEmpIds.length - backfillPairs.length > 0 ? missingEmpIds.length - new Set(backfillPairs.map(b => b.employeeId)).size : 0}`);
        if (unmatchedNames.size > 0) {
          console.log(`[getPresence] unmatched event names (sample):`, [...unmatchedNames].slice(0, 5));
          console.log(`[getPresence] employee names (sample):`, [...nameToEmpId.keys()].slice(0, 5));
        }

        // Backfill employee_id в фоне + пересчёт daily_summary
        if (backfillPairs.length > 0) {
          const uniqueBackfilledEmpIds = [...new Set(backfillPairs.map(b => b.employeeId))];
          supabase
            .rpc('bulk_update_employee_ids', {
              p_event_ids: backfillPairs.map(b => b.eventId),
              p_employee_ids: backfillPairs.map(b => b.employeeId),
            })
            .then(
              async () => {
                console.log(`[getPresence] backfilled employee_id for ${backfillPairs.length} events`);
                // Пересчитываем daily_summary для бэкфиллнутых сотрудников
                if (organizationId && uniqueBackfilledEmpIds.length > 0) {
                  const pairs = uniqueBackfilledEmpIds.map(empId => ({
                    org_id: organizationId,
                    emp_id: empId,
                    date: today,
                  }));
                  await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
                  console.log(`[getPresence] recalculated daily_summary for ${pairs.length} employees`);
                }
              },
              (err: Error) => { console.error('[getPresence] backfill error:', err); },
            );
        }
      }

      // Пересортировка fallback-событий в ASC
      for (const events of allExternalEvents.values()) {
        events.sort((a, b) => a.event_time.localeCompare(b.event_time));
      }

      // Загружаем daily summary за сегодня для total_hours и first_entry
      const { data: dailySummaries } = await supabase
        .from('skud_daily_summary')
        .select('employee_id, first_entry, total_hours')
        .eq('date', today)
        .in('employee_id', empIds);

      const summaryMap = new Map<number, { first_entry: string | null; total_hours: number | null }>();
      for (const s of dailySummaries || []) {
        summaryMap.set(s.employee_id, { first_entry: s.first_entry, total_hours: s.total_hours });
      }

      // Хелпер: подсчёт выходов и времени вне офиса
      const computeExitMetrics = (events: Array<{ event_time: string; direction: string | null }>) => {
        let exitCount = 0;
        let timeOutsideMs = 0;
        let lastExitTime: Date | null = null;

        for (const evt of events) {
          if (evt.direction === 'exit') {
            exitCount++;
            lastExitTime = new Date(`${today}T${evt.event_time}`);
          } else if (evt.direction === 'entry' && lastExitTime) {
            const entryTime = new Date(`${today}T${evt.event_time}`);
            timeOutsideMs += entryTime.getTime() - lastExitTime.getTime();
            lastExitTime = null;
          }
        }

        // Если сотрудник сейчас вне офиса — считаем до текущего момента
        if (lastExitTime) {
          timeOutsideMs += Date.now() - lastExitTime.getTime();
        }

        return { exit_count: exitCount, time_outside_minutes: Math.round(timeOutsideMs / 60_000) };
      };

      // Формируем ответ
      const result = employees.map(emp => {
        const last = latestEvent.get(emp.id);
        let status: 'online' | 'offline' | 'unknown' = 'unknown';
        let since: string | null = null;

        if (last) {
          status = last.direction === 'entry' ? 'online' : 'offline';
          since = last.event_time;
        }

        const summary = summaryMap.get(emp.id);
        const empEvents = allExternalEvents.get(emp.id) || [];
        const { exit_count, time_outside_minutes } = computeExitMetrics(empEvents);

        return {
          employee_id: emp.id,
          full_name: emp.full_name || '',
          department_name: emp.org_department_id ? deptMap.get(emp.org_department_id) || null : null,
          position_name: emp.position_id ? posMap.get(emp.position_id) || null : null,
          status,
          since,
          first_entry: summary?.first_entry || null,
          total_hours: summary?.total_hours || null,
          exit_count,
          time_outside_minutes,
        };
      });

      // Сортировка: online первыми, затем offline, unknown последние
      const statusOrder: Record<string, number> = { online: 0, offline: 1, unknown: 2 };
      result.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Get presence error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения статусов' });
    }
  },

  /**
   * POST /api/skud/sync-employee
   * Синхронизация событий Sigur для конкретного сотрудника
   * Body: { employeeId: number, startDate: string, endDate: string }
   */
  async syncEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { employeeId, startDate, endDate } = req.body as {
        employeeId: unknown;
        startDate: unknown;
        endDate: unknown;
      };

      if (typeof employeeId !== 'number' || !Number.isInteger(employeeId)) {
        res.status(400).json({ success: false, error: 'employeeId должен быть целым числом' });
        return;
      }
      if (typeof startDate !== 'string' || typeof endDate !== 'string' || !startDate || !endDate) {
        res.status(400).json({ success: false, error: 'startDate и endDate обязательны (YYYY-MM-DD)' });
        return;
      }
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      // 1. Загрузка сотрудника
      const orgId = getOrgId(req);
      let empQuery = supabase
        .from('employees')
        .select('id, organization_id, full_name, sigur_employee_id')
        .eq('id', employeeId)
        .eq('is_archived', false);
      if (orgId) empQuery = empQuery.eq('organization_id', orgId);

      const { data: empData, error: empError } = await empQuery.single();
      if (empError || !empData) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      const sigurEmpId: number | null = empData.sigur_employee_id;
      const employeeOrgId: string = empData.organization_id;
      const employeeName = (empData.full_name || '').toLowerCase().trim();

      console.log(`[sync-employee] id=${employeeId}, sigurId=${sigurEmpId}, name="${employeeName}"`);

      // 2. Список дней
      const days: string[] = [];
      const cur = new Date(startDate);
      const end = new Date(endDate);
      while (cur <= end) {
        days.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
      }

      // 3. SSE-стрим прогресса
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const send = (data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const summariesToUpdate = new Set<string>();
      let totalInserted = 0;
      let totalSkipped = 0;
      let totalRaw = 0;

      send({ type: 'start', totalDays: days.length, employeeName });

      // 4. Обработка по дням
      for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
        const day = days[dayIdx];
        const dayStart = `${day}T00:00:00`;
        const dayEnd = `${day}T23:59:59`;

        send({ type: 'day_start', day, dayIndex: dayIdx, totalDays: days.length, percent: Math.round((dayIdx / days.length) * 100) });

        const rawEvents = await sigurService.getEvents(dayStart, dayEnd, connection, 'PASS_DETECTED', { pageSize: 3000 });
        totalRaw += rawEvents.length;

        if (rawEvents.length === 0) {
          send({ type: 'day_done', day, raw: 0, matched: 0, inserted: 0 });
          continue;
        }

        // Быстрая фильтрация по sigurEmpId на сырых данных (без маппинга)
        const filtered = rawEvents.filter(raw => {
          const r = raw as Record<string, any>;
          const evtEmpId = r.data?.employeeId ?? r.additionalData?.accessObject?.data?.id;
          if (sigurEmpId != null && evtEmpId != null) return evtEmpId === sigurEmpId;
          const name = r.additionalData?.accessObject?.data?.name;
          return typeof name === 'string' && name.toLowerCase().trim() === employeeName;
        });

        if (filtered.length === 0) {
          send({ type: 'day_done', day, raw: rawEvents.length, matched: 0, inserted: 0 });
          continue;
        }

        const mapped = filtered
          .map(raw => mapSigurEvent(raw as Record<string, unknown>))
          .filter((m): m is NonNullable<typeof m> => m !== null);

        // Дедупликация по хэшам (с фильтром по организации)
        const { data: existingHashes } = await supabase
          .from('skud_events')
          .select('dedup_hash')
          .eq('event_date', day)
          .eq('organization_id', employeeOrgId)
          .not('dedup_hash', 'is', null);

        const existingSet = new Set<string>();
        for (const evt of existingHashes || []) {
          if (evt.dedup_hash) existingSet.add(evt.dedup_hash);
        }

        const toInsert: SkudEventRow[] = [];
        for (const m of mapped) {
          const dedupHash = computeDedupHash(
            m.physicalPerson, m.eventDate, m.eventTime,
            m.accessPoint, m.direction,
          );
          if (existingSet.has(dedupHash)) {
            totalSkipped++;
            continue;
          }
          existingSet.add(dedupHash);
          toInsert.push({
            organization_id: employeeOrgId,
            physical_person: m.physicalPerson,
            card_number: m.cardNumber || null,
            event_date: m.eventDate,
            event_time: m.eventTime,
            access_point: m.accessPoint,
            direction: m.direction,
            employee_id: employeeId,
            dedup_hash: dedupHash,
          });
          summariesToUpdate.add(m.eventDate);
        }

        let dayInserted = 0;
        const BATCH = 500;
        for (let i = 0; i < toInsert.length; i += BATCH) {
          const batch = toInsert.slice(i, i + BATCH);
          const { error: insertErr } = await supabase.from('skud_events').upsert(batch, { onConflict: 'dedup_hash', ignoreDuplicates: true });
          if (!insertErr) {
            dayInserted += batch.length;
            totalInserted += batch.length;
          }
        }

        send({ type: 'day_done', day, raw: rawEvents.length, matched: filtered.length, inserted: dayInserted });
      }

      // 5. Пересчёт daily summary (пакетный RPC)
      if (summariesToUpdate.size > 0) {
        const pairs = [...summariesToUpdate].map(date => ({
          org_id: employeeOrgId, emp_id: employeeId, date,
        }));
        await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
      }

      // 6. Аудит
      await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR_EMPLOYEE', {
        details: { employeeId, sigurEmpId, startDate, endDate, rawFetched: totalRaw, inserted: totalInserted, skipped: totalSkipped },
      });

      console.log(`[sync-employee] done: raw=${totalRaw}, inserted=${totalInserted}, skipped=${totalSkipped}`);
      send({ type: 'done', inserted: totalInserted, skipped: totalSkipped, total: totalInserted + totalSkipped });
      res.end();
    } catch (error) {
      console.error('syncEmployee error:', error);
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'Ошибка синхронизации событий сотрудника' })}\n\n`);
        } catch { /* ignore */ }
        res.end();
      } else {
        res.status(500).json({ success: false, error: 'Ошибка синхронизации событий сотрудника' });
      }
    }
  },

  /**
   * POST /api/skud/clean-duplicates
   * Бэкфилл dedup_hash + удаление дублей
   */
  async cleanDuplicates(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const BATCH = 1000;
      let offset = 0;
      let totalUpdated = 0;
      let totalDeleted = 0;

      // 1. Бэкфилл: вычисляем dedup_hash для строк без него
      while (true) {
        const { data: rows } = await supabase
          .from('skud_events')
          .select('id, physical_person, event_date, event_time, access_point, direction')
          .is('dedup_hash', null)
          .order('id')
          .range(offset, offset + BATCH - 1);

        if (!rows || rows.length === 0) break;

        for (const row of rows) {
          const name = row.physical_person || '';
          const hash = computeDedupHash(name, row.event_date, row.event_time, row.access_point, row.direction);
          await supabase.from('skud_events').update({ dedup_hash: hash }).eq('id', row.id);
          totalUpdated++;
        }

        if (rows.length < BATCH) break;
        offset += BATCH;
      }

      // 2. Удаляем дубли: оставляем MIN(id) для каждого dedup_hash
      const { data: dupes } = await supabase.rpc('find_skud_duplicate_ids');
      if (dupes && dupes.length > 0) {
        const idsToDelete: number[] = dupes.map((d: { id: number }) => d.id);
        // Удаляем батчами
        for (let i = 0; i < idsToDelete.length; i += BATCH) {
          const batch = idsToDelete.slice(i, i + BATCH);
          await supabase.from('skud_events').delete().in('id', batch);
          totalDeleted += batch.length;
        }
      }

      await auditService.logFromRequest(req, req.user.id, 'CLEAN_SKUD_DUPLICATES', {
        details: { totalUpdated, totalDeleted },
      });

      res.json({ success: true, data: { hashesUpdated: totalUpdated, duplicatesDeleted: totalDeleted } });
    } catch (error) {
      console.error('Clean duplicates error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки дублей' });
    }
  },

  /**
   * DELETE /api/skud/clear
   * Очистка данных СКУД за период
   */
  async clear(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const { startDate, endDate } = req.body;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      let eventsQuery = supabase
        .from('skud_events')
        .delete()
        .eq('organization_id', organizationId);

      let summaryQuery = supabase
        .from('skud_daily_summary')
        .delete()
        .eq('organization_id', organizationId);

      if (startDate) {
        eventsQuery = eventsQuery.gte('event_date', startDate);
        summaryQuery = summaryQuery.gte('date', startDate);
      }
      if (endDate) {
        eventsQuery = eventsQuery.lte('event_date', endDate);
        summaryQuery = summaryQuery.lte('date', endDate);
      }

      await eventsQuery;
      await summaryQuery;

      await auditService.logFromRequest(req, req.user.id, 'CLEAR_SKUD', {
        details: { startDate, endDate },
      });

      res.json({ success: true, message: 'Данные очищены' });
    } catch (error) {
      console.error('Clear SKUD error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки данных' });
    }
  },

  /**
   * GET /api/skud/access-point-settings?department_id=uuid
   * Получение настроек точек доступа.
   * Если department_id не указан — возвращает общие настройки (корневой отдел организации).
   */
  async getAccessPointSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      let organizationId = getOrgId(req);
      let departmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;

      // super_admin без привязки — находим первую организацию
      if (!organizationId) {
        const { data: orgs } = await supabase.from('organizations').select('id').limit(1);
        organizationId = orgs?.[0]?.id;
      }

      // Если department_id не указан — загружаем все настройки организации
      if (!departmentId) {
        if (!organizationId) {
          res.json({ success: true, data: [] });
          return;
        }
        const { data, error } = await supabase
          .from('skud_access_point_settings')
          .select('access_point_name, is_internal')
          .eq('organization_id', organizationId);

        if (error) {
          console.error('Get access point settings error:', error);
          res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
          return;
        }

        const result = (data || []).map(row => ({
          access_point_name: row.access_point_name,
          is_internal: row.is_internal,
        }));
        res.json({ success: true, data: result });
        return;
      }

      // Если org не определён (super_admin), берём из отдела
      if (!organizationId) {
        const { data: dept } = await supabase.from('org_departments').select('organization_id').eq('id', departmentId).maybeSingle();
        organizationId = dept?.organization_id;
      }

      // Загружаем настройки для конкретного отдела
      let query = supabase
        .from('skud_access_point_settings')
        .select('access_point_name, is_internal')
        .eq('department_id', departmentId);

      if (organizationId) {
        query = query.eq('organization_id', organizationId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Get access point settings error:', error);
        res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
        return;
      }

      const result = (data || []).map(row => ({
        access_point_name: row.access_point_name,
        is_internal: row.is_internal,
      }));

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Get access point settings error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
    }
  },

  /**
   * PUT /api/skud/access-point-settings
   * Сохранение общих настроек точек доступа (на корневом отделе организации).
   * Body: { settings: [{ access_point_name: string, is_internal: boolean }], department_id?: string }
   */
  async saveAccessPointSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      let organizationId = getOrgId(req);
      if (!organizationId) {
        const { data: orgs } = await supabase.from('organizations').select('id').limit(1);
        organizationId = orgs?.[0]?.id;
      }

      const { department_id, settings } = req.body as {
        department_id?: string;
        settings: { access_point_name: string; is_internal: boolean }[];
      };

      if (!Array.isArray(settings)) {
        res.status(400).json({ success: false, error: 'settings обязательны' });
        return;
      }

      let targetDeptId = department_id || null;

      // Если department_id не указан — находим корневой отдел
      if (!targetDeptId) {
        if (!organizationId) {
          res.status(400).json({ success: false, error: 'Organization required' });
          return;
        }
        const { data: rootDepts } = await supabase
          .from('org_departments')
          .select('id')
          .eq('organization_id', organizationId)
          .is('parent_id', null)
          .limit(1);
        if (!rootDepts || rootDepts.length === 0) {
          res.status(400).json({ success: false, error: 'Корневой отдел не найден' });
          return;
        }
        targetDeptId = rootDepts[0].id;
      }

      // Если org не определён (super_admin без привязки), берём из отдела
      if (!organizationId) {
        const { data: dept } = await supabase.from('org_departments').select('organization_id').eq('id', targetDeptId).maybeSingle();
        organizationId = dept?.organization_id;
      }

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      // Удалить старые настройки организации (все отделы)
      await supabase
        .from('skud_access_point_settings')
        .delete()
        .eq('organization_id', organizationId);

      // Вставить новые (только те, что помечены как internal)
      const internalSettings = settings.filter(s => s.is_internal);
      if (internalSettings.length > 0) {
        const rows = internalSettings.map(s => ({
          organization_id: organizationId,
          department_id: targetDeptId,
          access_point_name: s.access_point_name.trim(),
          is_internal: true,
        }));

        const { error } = await supabase
          .from('skud_access_point_settings')
          .insert(rows);

        if (error) {
          console.error('Save access point settings error:', error);
          res.status(500).json({ success: false, error: 'Ошибка сохранения настроек' });
          return;
        }
      }

      res.json({ success: true, message: 'Настройки сохранены' });
    } catch (error) {
      console.error('Save access point settings error:', error);
      res.status(500).json({ success: false, error: 'Ошибка сохранения настроек' });
    }
  },

  /**
   * GET /api/skud/organizations
   * Возвращает только организации, у которых есть события в skud_events (super_admin)
   */
  async getOrganizations(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Получаем уникальные organization_id из skud_events
      const { data: rows, error } = await supabase
        .from('skud_events')
        .select('organization_id')
        .not('organization_id', 'is', null);

      if (error) {
        res.status(500).json({ success: false, error: error.message });
        return;
      }

      const uniqueOrgIds = [...new Set((rows || []).map(r => r.organization_id))];
      if (uniqueOrgIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      // Получаем названия организаций
      const { data: orgs } = await supabase
        .from('organizations')
        .select('id, name')
        .in('id', uniqueOrgIds)
        .order('name');

      res.json({ success: true, data: orgs || [] });
    } catch (error) {
      console.error('Get SKUD organizations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки организаций' });
    }
  },
};

// Вспомогательные функции

function isHeaderRow(row: (string | number | Date | null)[]): boolean {
  if (!row || row.length === 0) return false;
  const firstCell = String(row[0] || '').toLowerCase();
  return (
    firstCell.includes('фио') ||
    firstCell.includes('имя') ||
    firstCell.includes('person') ||
    firstCell.includes('физ') ||
    firstCell.includes('сотрудник') ||
    firstCell === '№'
  );
}

// Извлекает время из строки "Дата и Время" (например: "27.01.2026 09:30:00" или "2026-01-27 09:30")
function parseTimeFromDateTime(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;

  const str = String(value).trim();
  if (!str) return null;

  // Ищем время в формате HH:MM или HH:MM:SS
  const timeMatch = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    const [, hours, minutes, seconds = '00'] = timeMatch;
    return `${hours.padStart(2, '0')}:${minutes}:${seconds}`;
  }

  // Excel десятичное время
  if (!isNaN(Number(str))) {
    const num = Number(str);
    // Если это дробная часть дня (время)
    const timePart = num % 1;
    if (timePart > 0) {
      const totalMinutes = Math.round(timePart * 24 * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    }
  }

  return null;
}

function parseTime(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;

  const str = String(value).trim();
  if (!str) return null;

  // HH:MM или HH:MM:SS
  const timeMatch = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeMatch) {
    const [, hours, minutes, seconds = '00'] = timeMatch;
    return `${hours.padStart(2, '0')}:${minutes}:${seconds}`;
  }

  // Excel десятичное время (0.5 = 12:00)
  if (!isNaN(Number(str))) {
    const num = Number(str);
    if (num >= 0 && num < 1) {
      const totalMinutes = Math.round(num * 24 * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    }
  }

  return null;
}
