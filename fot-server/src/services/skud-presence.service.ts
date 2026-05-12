/**
 * СКУД: логика присутствия сотрудников (GET /api/skud/presence).
 */
import { query } from '../config/postgres.js';
import { formatDateToISO } from '../utils/date.utils.js';
import type { IPresenceParams, IPresenceItem } from '../types/skud.types.js';
import { getAllDepartmentsTree, getInternalAccessPoints } from './skud-shared.service.js';

// In-memory кэш по ключу departmentId (TTL 30с). Снижает нагрузку при множественных
// пользователях, смотрящих один отдел одновременно между socket-refetch и fallback polling.
const presenceCache = new Map<string, { data: IPresenceItem[]; expiresAt: number }>();
const PRESENCE_TTL_MS = 30_000;

export function invalidatePresenceCache(): void {
  presenceCache.clear();
}

export async function getPresence(params: IPresenceParams): Promise<IPresenceItem[]> {
  const { departmentId } = params;

  const cacheKey = departmentId ?? '__all__';
  const cached = presenceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const allDepts = await getAllDepartmentsTree();

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

  const empConditions: string[] = ['is_archived = false', "employment_status = 'active'"];
  const empParams: unknown[] = [];
  if (deptIds) {
    empParams.push(deptIds);
    empConditions.push(`org_department_id = ANY($${empParams.length}::uuid[])`);
  }
  const employees = await query<{
    id: number;
    full_name: string | null;
    org_department_id: string | null;
    position_id: string | null;
  }>(
    `SELECT id, full_name, org_department_id, position_id FROM employees
     WHERE ${empConditions.join(' AND ')}`,
    empParams,
  );

  if (!employees || employees.length === 0) {
    presenceCache.set(cacheKey, { data: [], expiresAt: Date.now() + PRESENCE_TTL_MS });
    return [];
  }

  const empIds = employees.map(e => e.id);

  const deptIdSet = new Set(employees.map(e => e.org_department_id).filter((v): v is string => !!v));
  const posIdSet = new Set(employees.map(e => e.position_id).filter((v): v is string => !!v));

  const [deptRows, posRows] = await Promise.all([
    deptIdSet.size > 0
      ? query<{ id: string; name: string | null }>(
          'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
          [[...deptIdSet]],
        )
      : Promise.resolve([] as { id: string; name: string | null }[]),
    posIdSet.size > 0
      ? query<{ id: string; name: string | null }>(
          'SELECT id, name FROM positions WHERE id = ANY($1::uuid[])',
          [[...posIdSet]],
        )
      : Promise.resolve([] as { id: string; name: string | null }[]),
  ]);

  const deptMap = new Map<string, string>();
  for (const d of deptRows) {
    deptMap.set(d.id, d.name || '');
  }
  const posMap = new Map<string, string>();
  for (const p of posRows) {
    posMap.set(p.id, p.name || '');
  }

  const orgInternalPoints = await getInternalAccessPoints();

  const today = formatDateToISO(new Date());

  const eventsByEmpId = await query<{
    employee_id: number | null;
    event_time: string;
    direction: string | null;
    access_point: string | null;
  }>(
    `SELECT employee_id, event_time, direction, access_point FROM skud_events
     WHERE event_date = $1 AND employee_id = ANY($2::bigint[])
     ORDER BY event_time DESC`,
    [today, empIds],
  );

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

  const dailySummaries = await query<{
    employee_id: number;
    first_entry: string | null;
    total_hours: number | null;
  }>(
    `SELECT employee_id, first_entry, total_hours FROM skud_daily_summary
     WHERE date = $1 AND employee_id = ANY($2::bigint[])`,
    [today, empIds],
  );

  const monthStart = today.slice(0, 7) + '-01';
  const monthSummaries = await query<{ employee_id: number; first_entry: string | null }>(
    `SELECT employee_id, first_entry FROM skud_daily_summary
     WHERE date >= $1 AND date <= $2 AND is_present = true AND employee_id = ANY($3::bigint[])`,
    [monthStart, today, empIds],
  );

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

    const firstEntryEvent = empEvents.find(e => e.direction === 'entry');
    const firstEntry = firstEntryEvent?.event_time || summary?.first_entry || null;

    let totalHours = summary?.total_hours || null;
    if (!totalHours || totalHours === 0) {
      let pairMs = 0;
      let entryTime: number | null = null;
      for (const evt of empEvents) {
        if (evt.direction === 'entry') {
          if (entryTime === null) {
            const [eh, em, es] = evt.event_time.split(':').map(Number);
            entryTime = (eh * 3600 + em * 60 + (es || 0)) * 1000;
          }
        } else if (evt.direction === 'exit' && entryTime !== null) {
          const [xh, xm, xs] = evt.event_time.split(':').map(Number);
          const exitMs = (xh * 3600 + xm * 60 + (xs || 0)) * 1000;
          pairMs += exitMs - entryTime;
          entryTime = null;
        }
      }
      if (entryTime !== null && status === 'online') {
        const msk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
        const nowMs = (msk.getHours() * 3600 + msk.getMinutes() * 60 + msk.getSeconds()) * 1000;
        if (nowMs > entryTime) pairMs += nowMs - entryTime;
      }
      if (pairMs > 0) {
        totalHours = pairMs / 3_600_000;
      }
    }

    return {
      employee_id: emp.id,
      full_name: emp.full_name || '',
      department_name: emp.org_department_id ? deptMap.get(emp.org_department_id) || null : null,
      position_name: emp.position_id ? posMap.get(emp.position_id) || null : null,
      status,
      since,
      first_entry: firstEntry,
      total_hours: totalHours,
      exit_count,
      time_outside_minutes,
      last_access_point: last?.access_point || null,
      punctuality_percent: punctualityMap.get(emp.id) ?? null,
    };
  });

  const statusOrder: Record<string, number> = { online: 0, offline: 1, unknown: 2 };
  result.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  presenceCache.set(cacheKey, { data: result, expiresAt: Date.now() + PRESENCE_TTL_MS });
  return result;
}
