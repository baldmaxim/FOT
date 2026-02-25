import { Response } from 'express';
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
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
  physical_person_encrypted: string;
  card_number_encrypted: string | null;
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
    .order('event_time', { ascending: false });

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
      const name = encryptionService.decrypt(ev.physical_person_encrypted).toLowerCase().trim();
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

/** Вычисляет понедельник текущей/указанной недели */
function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];

// Кэш access points (TTL 10 минут)
const AP_CACHE_TTL = 10 * 60_000;
const accessPointCache = new Map<string, { data: string[]; at: number }>();

export const skudController = {
  /**
   * GET /api/skud/dashboard-stats?department_id=uuid
   * Агрегированная аналитика для дашборда руководителя
   */
  async getDashboardStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const departmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;

      if (!departmentId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }

      const deptIds = await collectDeptIds(departmentId, organizationId);

      // Загрузить сотрудников отдела
      let empQuery = supabase
        .from('employees')
        .select('id, full_name_encrypted')
        .eq('is_archived', false)
        .eq('employment_status', 'active')
        .in('org_department_id', deptIds);
      if (organizationId) empQuery = empQuery.eq('organization_id', organizationId);

      const { data: employees } = await empQuery;
      if (!employees || employees.length === 0) {
        res.json({ success: true, data: { lateToday: 0, lateYesterday: 0, punctuality: { onTime: 0, slightlyLate: 0, veryLate: 0 }, avgArrivalByDay: [], risks: [], hourlyActivity: [], weekComparison: null, topLate: [] } });
        return;
      }

      const empIds = employees.map(e => e.id);
      const empNameMap = new Map<number, string>();
      for (const e of employees) {
        empNameMap.set(e.id, encryptionService.decrypt(e.full_name_encrypted));
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

      // Вчера (рабочий день — пропускаем выходные)
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      while (yesterday.getDay() === 0 || yesterday.getDay() === 6) {
        yesterday.setDate(yesterday.getDate() - 1);
      }
      const yesterdayStr = formatDateToISO(yesterday);

      // Запрос daily_summary за 2 недели
      const { data: summaries } = await supabase
        .from('skud_daily_summary')
        .select('employee_id, date, first_entry, last_exit, total_hours, is_present')
        .in('employee_id', empIds)
        .gte('date', lastMondayStr)
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

      // Punctuality (this week only)
      const thisWeekSummaries = (summaries || []).filter(s => s.date >= mondayStr && s.date <= todayStr && s.first_entry);
      let onTimeCount = 0;
      let slightlyLateCount = 0;
      let veryLateCount = 0;
      for (const s of thisWeekSummaries) {
        if (s.first_entry! <= LATE_THRESHOLD) onTimeCount++;
        else if (s.first_entry! <= SLIGHTLY_LATE_THRESHOLD) slightlyLateCount++;
        else veryLateCount++;
      }
      const totalPunct = thisWeekSummaries.length || 1;
      const punctuality = {
        onTime: Math.round((onTimeCount / totalPunct) * 100),
        slightlyLate: Math.round((slightlyLateCount / totalPunct) * 100),
        veryLate: Math.round((veryLateCount / totalPunct) * 100),
      };

      // Average arrival by day (this week)
      const avgArrivalByDay: { day: string; avgTime: string | null; date: string }[] = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        const dateStr = formatDateToISO(d);
        if (dateStr > todayStr) {
          avgArrivalByDay.push({ day: DAY_NAMES[i], avgTime: null, date: dateStr });
          continue;
        }
        const dayEntries = (summaries || []).filter(s => s.date === dateStr && s.first_entry);
        if (dayEntries.length === 0) {
          avgArrivalByDay.push({ day: DAY_NAMES[i], avgTime: null, date: dateStr });
          continue;
        }
        const totalMinutes = dayEntries.reduce((sum, s) => {
          const [h, m] = s.first_entry!.split(':').map(Number);
          return sum + h * 60 + m;
        }, 0);
        const avgMin = Math.round(totalMinutes / dayEntries.length);
        const avgH = String(Math.floor(avgMin / 60)).padStart(2, '0');
        const avgM = String(avgMin % 60).padStart(2, '0');
        avgArrivalByDay.push({ day: DAY_NAMES[i], avgTime: `${avgH}:${avgM}`, date: dateStr });
      }

      // Risks (employees with most lates this week)
      const lateCountByEmp = new Map<number, number>();
      const earlyLeaveByEmp = new Map<number, number>();
      for (const s of thisWeekSummaries) {
        if (s.first_entry && s.first_entry > LATE_THRESHOLD) {
          lateCountByEmp.set(s.employee_id, (lateCountByEmp.get(s.employee_id) || 0) + 1);
        }
        if (s.last_exit && s.last_exit < '17:00:00' && s.is_present) {
          earlyLeaveByEmp.set(s.employee_id, (earlyLeaveByEmp.get(s.employee_id) || 0) + 1);
        }
      }

      const risks: { employee_id: number; full_name: string; reason: string; severity: 'high' | 'medium' }[] = [];
      for (const [empId, count] of lateCountByEmp) {
        if (count >= 3) {
          risks.push({ employee_id: empId, full_name: empNameMap.get(empId) || '', reason: `${count} опозданий за неделю`, severity: count >= 4 ? 'high' : 'medium' });
        }
      }
      for (const [empId, count] of earlyLeaveByEmp) {
        if (count >= 2 && !risks.find(r => r.employee_id === empId)) {
          risks.push({ employee_id: empId, full_name: empNameMap.get(empId) || '', reason: `Ранние уходы ${count} дня`, severity: 'medium' });
        }
      }
      risks.sort((a, b) => (a.severity === 'high' ? -1 : 1) - (b.severity === 'high' ? -1 : 1));

      // Hourly activity
      const hourlyMap = new Map<number, number>();
      for (let h = 7; h <= 19; h++) hourlyMap.set(h, 0);
      for (const evt of todayEvents || []) {
        if (!evt.event_time) continue;
        const hour = parseInt(evt.event_time.split(':')[0], 10);
        if (hour >= 7 && hour <= 19) {
          hourlyMap.set(hour, (hourlyMap.get(hour) || 0) + 1);
        }
      }
      const hourlyActivity = [...hourlyMap.entries()].map(([hour, count]) => ({ hour, count }));

      // Week comparison
      const lastWeekSummaries = (summaries || []).filter(s => s.date >= lastMondayStr && s.date <= lastFridayStr);

      const calcWeekMetrics = (weekData: typeof thisWeekSummaries) => {
        const withEntry = weekData.filter(s => s.first_entry);
        const presentDays = weekData.filter(s => s.is_present).length;
        const totalDays = weekData.length || 1;
        const attendanceRate = Math.round((presentDays / totalDays) * 100);

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

      const weekComparison = {
        thisWeek: calcWeekMetrics(thisWeekSummaries),
        lastWeek: calcWeekMetrics(lastWeekSummaries),
      };

      // Top late
      const topLate = [...lateCountByEmp.entries()]
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([empId, lateCount]) => ({
          employee_id: empId,
          full_name: empNameMap.get(empId) || '',
          lateCount,
        }));

      res.json({
        success: true,
        data: { lateToday, lateYesterday, punctuality, avgArrivalByDay, risks, hourlyActivity, weekComparison, topLate },
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
      let empQuery = supabase.from('employees').select('full_name_encrypted, organization_id').eq('id', employeeId);
      if (organizationId) empQuery = empQuery.eq('organization_id', organizationId);
      const { data: empData } = await empQuery.single();

      const effectiveOrgId = organizationId || empData?.organization_id || undefined;

      // 1) По employee_id
      const byId = await queryEventsByEmployeeId(employeeId, effectiveOrgId, startDate, endDate);
      console.log(`[employee-events] id=${employeeId} byId=${byId.length} orgId=${effectiveOrgId} dates=${startDate}..${endDate}`);

      // 2) Всегда ищем по ФИО (события без employee_id) + бэкфилл
      let byName: Record<string, unknown>[] = [];
      if (empData?.full_name_encrypted && effectiveOrgId) {
        const employeeName = encryptionService.decrypt(empData.full_name_encrypted).toLowerCase().trim();
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
        physical_person: encryptionService.decrypt(event.physical_person_encrypted as string),
        card_number: event.card_number_encrypted
          ? encryptionService.decrypt(event.card_number_encrypted as string) : null,
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

      const { data, error } = await query;

      if (error) {
        console.error('Get events error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch events' });
        return;
      }

      // Расшифровываем данные
      const decrypted = (data || []).map((event: {
        id: number;
        physical_person_encrypted: string;
        card_number_encrypted: string | null;
        event_date: string;
        event_time: string;
        access_point: string | null;
        direction: string | null;
        employee_id: number | null;
      }) => ({
        id: event.id,
        physical_person: encryptionService.decrypt(event.physical_person_encrypted),
        card_number: event.card_number_encrypted
          ? encryptionService.decrypt(event.card_number_encrypted)
          : null,
        event_date: event.event_date,
        event_time: event.event_time,
        access_point: event.access_point,
        direction: event.direction,
        employee_id: event.employee_id,
      }));

      // Серверный поиск по расшифрованным данным
      const result = searchStr
        ? decrypted.filter(e => e.physical_person.toLowerCase().includes(searchStr))
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
        .select('id, full_name_encrypted')
        .eq('organization_id', organizationId)
        .eq('is_archived', false);

      const employeeMap = new Map<string, number>();
      for (const emp of employeesData || []) {
        const name = encryptionService.decrypt(emp.full_name_encrypted).toLowerCase().trim();
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
          physical_person_encrypted: encryptionService.encrypt(physicalPerson),
          card_number_encrypted: cardNumber ? encryptionService.encrypt(cardNumber) : null,
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

      // Собираем ID отдела + все дочерние
      let deptIds: string[] | null = null;
      if (departmentId) {
        let deptQuery = supabase
          .from('org_departments')
          .select('id, parent_id');
        if (organizationId) deptQuery = deptQuery.eq('organization_id', organizationId);
        const { data: allDepts } = await deptQuery;

        deptIds = [departmentId];
        let changed = true;
        while (changed) {
          changed = false;
          for (const d of allDepts || []) {
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
        .select('id, full_name_encrypted, org_department_id, position_id')
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
          ? supabase.from('org_departments').select('id, name_encrypted').in('id', [...deptIdSet])
          : { data: [] },
        posIdSet.size > 0
          ? supabase.from('positions').select('id, name_encrypted').in('id', [...posIdSet])
          : { data: [] },
      ]);

      const deptMap = new Map<string, string>();
      for (const d of deptResult.data || []) {
        deptMap.set(d.id, encryptionService.decrypt(d.name_encrypted));
      }
      const posMap = new Map<string, string>();
      for (const p of posResult.data || []) {
        posMap.set(p.id, encryptionService.decrypt(p.name_encrypted));
      }

      // Загружаем настройки внутренних точек доступа для отделов
      const internalPointsByDept = new Map<string, Set<string>>();
      if (deptIdSet.size > 0) {
        let settingsQuery = supabase
          .from('skud_access_point_settings')
          .select('department_id, access_point_name')
          .eq('is_internal', true)
          .in('department_id', [...deptIdSet]);

        if (organizationId) {
          settingsQuery = settingsQuery.eq('organization_id', organizationId);
        }

        const { data: apSettings } = await settingsQuery;
        for (const s of apSettings || []) {
          if (!internalPointsByDept.has(s.department_id)) {
            internalPointsByDept.set(s.department_id, new Set());
          }
          internalPointsByDept.get(s.department_id)!.add(s.access_point_name);
        }
      }

      // Карта employee_id → Set<internal_access_point>
      const empInternalPoints = new Map<number, Set<string>>();
      for (const emp of employees) {
        if (emp.org_department_id && internalPointsByDept.has(emp.org_department_id)) {
          empInternalPoints.set(emp.id, internalPointsByDept.get(emp.org_department_id)!);
        }
      }

      // Загружаем события за сегодня (локальная дата, не UTC)
      const today = formatDateToISO(new Date());

      // Карта ФИО → employee.id для фоллбэка
      const nameToEmpId = new Map<string, number>();
      for (const emp of employees) {
        const name = encryptionService.decrypt(emp.full_name_encrypted).toLowerCase().trim();
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
      for (const evt of eventsByEmpId || []) {
        if (!evt.employee_id || latestEvent.has(evt.employee_id)) continue;
        // Пропускаем события от внутренних точек доступа
        const internal = empInternalPoints.get(evt.employee_id);
        if (internal && evt.access_point && internal.has(evt.access_point)) continue;
        latestEvent.set(evt.employee_id, { event_time: evt.event_time, direction: evt.direction });
      }

      // 2) Фоллбэк: если есть сотрудники без событий — ищем по ФИО
      const missingEmpIds = empIds.filter(id => !latestEvent.has(id));
      if (missingEmpIds.length > 0) {
        let fallbackQuery = supabase
          .from('skud_events')
          .select('physical_person_encrypted, event_time, direction, access_point, id')
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
          const evtName = encryptionService.decrypt(evt.physical_person_encrypted).toLowerCase().trim();
          const empId = nameToEmpId.get(evtName);
          if (!empId) {
            unmatchedNames.add(evtName);
            continue;
          }

          if (!latestEvent.has(empId)) {
            // Пропускаем события от внутренних точек доступа
            const internal = empInternalPoints.get(empId);
            if (!(internal && evt.access_point && internal.has(evt.access_point))) {
              latestEvent.set(empId, { event_time: evt.event_time, direction: evt.direction });
            }
          }
          backfillPairs.push({ eventId: evt.id, employeeId: empId });
        }

        console.log(`[getPresence] date=${today}, empById=${(eventsByEmpId || []).length}, unmatchedEvts=${(unmatchedEvents || []).length}, matchedByName=${backfillPairs.length}, noMatch=${unmatchedNames.size}, missing=${missingEmpIds.length - backfillPairs.length > 0 ? missingEmpIds.length - new Set(backfillPairs.map(b => b.employeeId)).size : 0}`);
        if (unmatchedNames.size > 0) {
          console.log(`[getPresence] unmatched event names (sample):`, [...unmatchedNames].slice(0, 5));
          console.log(`[getPresence] employee names (sample):`, [...nameToEmpId.keys()].slice(0, 5));
        }

        // Backfill employee_id в фоне (пакетный RPC)
        if (backfillPairs.length > 0) {
          supabase
            .rpc('bulk_update_employee_ids', {
              p_event_ids: backfillPairs.map(b => b.eventId),
              p_employee_ids: backfillPairs.map(b => b.employeeId),
            })
            .then(
              () => { console.log(`[getPresence] backfilled employee_id for ${backfillPairs.length} events`); },
              (err: Error) => { console.error('[getPresence] backfill error:', err); },
            );
        }
      }

      // Формируем ответ
      const result = employees.map(emp => {
        const last = latestEvent.get(emp.id);
        let status: 'online' | 'offline' | 'unknown' = 'unknown';
        let since: string | null = null;

        if (last) {
          status = last.direction === 'entry' ? 'online' : 'offline';
          since = last.event_time;
        }

        return {
          employee_id: emp.id,
          full_name: encryptionService.decrypt(emp.full_name_encrypted),
          department_name: emp.org_department_id ? deptMap.get(emp.org_department_id) || null : null,
          position_name: emp.position_id ? posMap.get(emp.position_id) || null : null,
          status,
          since,
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
        .select('id, organization_id, full_name_encrypted, sigur_employee_id')
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
      const employeeName = encryptionService.decrypt(empData.full_name_encrypted).toLowerCase().trim();

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
            physical_person_encrypted: encryptionService.encrypt(m.physicalPerson),
            card_number_encrypted: m.cardNumber ? encryptionService.encrypt(m.cardNumber) : null,
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
      res.status(500).json({ success: false, error: 'Ошибка синхронизации событий сотрудника' });
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
          .select('id, physical_person_encrypted, event_date, event_time, access_point, direction')
          .is('dedup_hash', null)
          .order('id')
          .range(offset, offset + BATCH - 1);

        if (!rows || rows.length === 0) break;

        for (const row of rows) {
          const name = encryptionService.decrypt(row.physical_person_encrypted);
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
   * Получение настроек точек доступа для отдела
   */
  async getAccessPointSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      let organizationId = getOrgId(req);
      const departmentId = typeof req.query.department_id === 'string' ? req.query.department_id : null;

      if (!departmentId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }

      // Если org не определён (super_admin), берём из отдела
      if (!organizationId) {
        const { data: dept } = await supabase.from('org_departments').select('organization_id').eq('id', departmentId).single();
        organizationId = dept?.organization_id;
      }

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

      res.json({ success: true, data: data || [] });
    } catch (error) {
      console.error('Get access point settings error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
    }
  },

  /**
   * PUT /api/skud/access-point-settings
   * Сохранение настроек точек доступа для отдела
   * Body: { department_id: string, settings: [{ access_point_name: string, is_internal: boolean }] }
   */
  async saveAccessPointSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      let organizationId = getOrgId(req);

      const { department_id, settings } = req.body as {
        department_id: string;
        settings: { access_point_name: string; is_internal: boolean }[];
      };

      if (!department_id || !Array.isArray(settings)) {
        res.status(400).json({ success: false, error: 'department_id и settings обязательны' });
        return;
      }

      // Если org не определён (super_admin без привязки), берём из отдела
      if (!organizationId) {
        const { data: dept } = await supabase.from('org_departments').select('organization_id').eq('id', department_id).single();
        organizationId = dept?.organization_id;
      }

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      // Удалить старые настройки для этого отдела
      await supabase
        .from('skud_access_point_settings')
        .delete()
        .eq('organization_id', organizationId)
        .eq('department_id', department_id);

      // Вставить новые (только те, что помечены как internal)
      const internalSettings = settings.filter(s => s.is_internal);
      if (internalSettings.length > 0) {
        const rows = internalSettings.map(s => ({
          organization_id: organizationId,
          department_id,
          access_point_name: s.access_point_name,
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
