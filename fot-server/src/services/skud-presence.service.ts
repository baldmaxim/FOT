/**
 * СКУД: логика присутствия сотрудников (GET /api/skud/presence).
 */
import { query } from '../config/postgres.js';
import { formatDateToISO } from '../utils/date.utils.js';
import type { IPresenceParams, IPresenceItem } from '../types/skud.types.js';
import { getAllDepartmentsTree, getInternalAccessPoints } from './skud-shared.service.js';
import { createSwrCache } from '../utils/swr-cache.js';

// SWR-кэш по ключу departmentId: TTL 30с (свежесть), окно stale 10м.
// Протухшее значение отдаётся мгновенно + фоновая ревалидация — страница
// «Сотрудники на объектах» не ждёт холодного пересчёта.
const PRESENCE_TTL_MS = 30_000;
const PRESENCE_STALE_MS = 10 * 60_000;
const presenceCache = createSwrCache<IPresenceItem[]>();

export function invalidatePresenceCache(): void {
  presenceCache.clear();
}

/** Перегреть «горячий» scope (все отделы) свежими данными в фоне —
 *  вызывается из realtime-нотификации при новых СКУД-событиях. */
export function rewarmPresenceAll(): void {
  presenceCache.refreshNow(
    '__all__',
    PRESENCE_TTL_MS,
    PRESENCE_STALE_MS,
    () => computePresence({ departmentId: null }),
  );
}

export async function getPresence(params: IPresenceParams): Promise<IPresenceItem[]> {
  const cacheKey = params.departmentId ?? '__all__';
  return presenceCache.getOrRefresh(
    cacheKey,
    PRESENCE_TTL_MS,
    PRESENCE_STALE_MS,
    () => computePresence(params),
  );
}

async function computePresence(params: IPresenceParams): Promise<IPresenceItem[]> {
  const { departmentId } = params;

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
  // Внутренние точки фильтруются в SQL (раньше — в JS). null → фильтр не применяется.
  const internalArr = orgInternalPoints.size > 0 ? [...orgInternalPoints] : null;

  const today = formatDateToISO(new Date());

  // События дня без внутренних точек, упорядочены ASC по сотруднику/времени.
  // Старый код тянул все события, фильтровал внутренние и строил Map в JS.
  const eventRows = await query<{
    employee_id: number | null;
    event_time: string;
    direction: string | null;
    access_point: string | null;
  }>(
    `SELECT employee_id, event_time, direction, access_point FROM skud_events
     WHERE event_date = $1 AND employee_id = ANY($2::bigint[])
       AND ($3::text[] IS NULL OR access_point IS NULL OR access_point = ''
            OR access_point <> ALL($3::text[]))
     ORDER BY employee_id ASC, event_time ASC`,
    [today, empIds, internalArr],
  );

  // Группировка по сотруднику (строки уже ASC и без внутренних точек —
  // эквивалент прежних allExternalEvents после reverse()).
  const eventsByEmp = new Map<number, Array<{ event_time: string; direction: string | null; access_point: string | null }>>();
  for (const evt of eventRows || []) {
    if (!evt.employee_id) continue;
    let arr = eventsByEmp.get(evt.employee_id);
    if (!arr) {
      arr = [];
      eventsByEmp.set(evt.employee_id, arr);
    }
    arr.push({ event_time: evt.event_time, direction: evt.direction, access_point: evt.access_point || null });
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
  // Пунктуальность агрегируется в SQL (раньше — выгрузка всех present-дней
  // месяца по всем сотрудникам + цикл; на крупном масштабе это был главный
  // объём пересылки). Процент считаем в JS Math.round — точный паритет.
  const punctualityRows = await query<{ employee_id: number; total: number; on_time: number }>(
    `SELECT employee_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE first_entry IS NOT NULL AND first_entry <= '09:00:00')::int AS on_time
     FROM skud_daily_summary
     WHERE date >= $1 AND date <= $2 AND is_present = true AND employee_id = ANY($3::bigint[])
     GROUP BY employee_id`,
    [monthStart, today, empIds],
  );
  const punctualityMap = new Map<number, number>();
  for (const r of punctualityRows || []) {
    const total = Number(r.total) || 0;
    const onTime = Number(r.on_time) || 0;
    punctualityMap.set(r.employee_id, total > 0 ? Math.round((onTime / total) * 100) : 100);
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
    const empEvents = eventsByEmp.get(emp.id) || [];
    // empEvents — ASC по времени; последнее = событие с макс. event_time
    // (эквивалент прежнего latestEvent из DESC-итерации).
    const last = empEvents.length > 0 ? empEvents[empEvents.length - 1] : null;
    let status: 'online' | 'offline' | 'unknown' = 'unknown';
    let since: string | null = null;

    if (last) {
      status = last.direction === 'entry' ? 'online' : 'offline';
      since = last.event_time;
    }

    const summary = summaryMap.get(emp.id);
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

  return result;
}
