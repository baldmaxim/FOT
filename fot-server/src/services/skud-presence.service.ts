/**
 * СКУД: логика присутствия сотрудников (GET /api/skud/presence).
 */
import { supabase } from '../config/database.js';
import { formatDateToISO } from '../utils/date.utils.js';
import type { IPresenceParams, IPresenceItem } from '../types/skud.types.js';

export async function getPresence(params: IPresenceParams): Promise<IPresenceItem[]> {
  const { organizationId, departmentId } = params;

  // Загружаем все отделы
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

  // Если есть departmentId — фильтруем по отделам (org_department_id), иначе по организации
  if (deptIds) {
    empQuery = empQuery.in('org_department_id', deptIds);
  } else if (organizationId) {
    empQuery = empQuery.eq('organization_id', organizationId);
  }

  const { data: employees } = await empQuery;
  if (!employees || employees.length === 0) {
    return [];
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

  // Загружаем все внутренние точки доступа организации
  let settingsQuery = supabase
    .from('skud_access_point_settings')
    .select('access_point_name')
    .eq('is_internal', true);

  if (organizationId) settingsQuery = settingsQuery.eq('organization_id', organizationId);

  const { data: apSettings } = await settingsQuery;
  const orgInternalPoints = new Set<string>(
    (apSettings || []).map(s => s.access_point_name.trim()),
  );

  const today = formatDateToISO(new Date());

  // Запрос событий по employee_id (backfill выполняется отдельно в polling-цикле)
  const { data: eventsByEmpId } = await supabase
    .from('skud_events')
    .select('employee_id, event_time, direction, access_point')
    .eq('event_date', today)
    .in('employee_id', empIds)
    .order('event_time', { ascending: false });

  const latestEvent = new Map<number, { event_time: string; direction: string | null; access_point: string | null }>();
  const allExternalEvents = new Map<number, Array<{ event_time: string; direction: string | null }>>();

  for (const evt of eventsByEmpId || []) {
    if (!evt.employee_id) continue;
    if (orgInternalPoints.size > 0 && evt.access_point && orgInternalPoints.has(evt.access_point)) continue;

    if (!latestEvent.has(evt.employee_id)) {
      latestEvent.set(evt.employee_id, { event_time: evt.event_time, direction: evt.direction, access_point: evt.access_point || null });
    }
    if (!allExternalEvents.has(evt.employee_id)) {
      allExternalEvents.set(evt.employee_id, []);
    }
    allExternalEvents.get(evt.employee_id)!.push({ event_time: evt.event_time, direction: evt.direction });
  }

  // eventsByEmpId отсортирован DESC — переворачиваем в ASC
  for (const events of allExternalEvents.values()) {
    events.reverse();
  }

  // Загружаем daily summary за сегодня
  const { data: dailySummaries } = await supabase
    .from('skud_daily_summary')
    .select('employee_id, first_entry, total_hours')
    .eq('date', today)
    .in('employee_id', empIds);

  // Загружаем пунктуальность за текущий месяц
  const monthStart = today.slice(0, 7) + '-01';
  const { data: monthSummaries } = await supabase
    .from('skud_daily_summary')
    .select('employee_id, first_entry')
    .gte('date', monthStart)
    .lte('date', today)
    .eq('is_present', true)
    .in('employee_id', empIds);

  const punctualityMap = new Map<number, number>();
  if (monthSummaries && monthSummaries.length > 0) {
    const byEmp = new Map<number, { total: number; onTime: number }>();
    for (const s of monthSummaries) {
      if (!byEmp.has(s.employee_id)) byEmp.set(s.employee_id, { total: 0, onTime: 0 });
      const rec = byEmp.get(s.employee_id)!;
      rec.total++;
      if (s.first_entry && s.first_entry <= '09:00:00') rec.onTime++;
    }
    for (const [empId, rec] of byEmp) {
      punctualityMap.set(empId, rec.total > 0 ? Math.round((rec.onTime / rec.total) * 100) : 100);
    }
  }

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

    if (lastExitTime) {
      timeOutsideMs += Date.now() - lastExitTime.getTime();
    }

    return { exit_count: exitCount, time_outside_minutes: Math.round(timeOutsideMs / 60_000) };
  };

  // Формируем ответ
  const result: IPresenceItem[] = employees.map(emp => {
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

    // Если сотрудник на месте (online) и total_hours = 0 или null — считаем от first_entry до сейчас
    let totalHours = summary?.total_hours || null;
    if (status === 'online' && summary?.first_entry && (!totalHours || totalHours === 0)) {
      const [fh, fm, fs] = summary.first_entry.split(':').map(Number);
      const entryMs = (fh * 3600 + fm * 60 + (fs || 0)) * 1000;
      const now = new Date();
      const nowMs = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000;
      if (nowMs > entryMs) {
        totalHours = (nowMs - entryMs) / 3_600_000;
      }
    }

    return {
      employee_id: emp.id,
      full_name: emp.full_name || '',
      department_name: emp.org_department_id ? deptMap.get(emp.org_department_id) || null : null,
      position_name: emp.position_id ? posMap.get(emp.position_id) || null : null,
      status,
      since,
      first_entry: summary?.first_entry || null,
      total_hours: totalHours,
      exit_count,
      time_outside_minutes,
      last_access_point: last?.access_point || null,
      punctuality_percent: punctualityMap.get(emp.id) ?? null,
    };
  });

  // Сортировка: online первыми, затем offline, unknown последние
  const statusOrder: Record<string, number> = { online: 0, offline: 1, unknown: 2 };
  result.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return result;
}
