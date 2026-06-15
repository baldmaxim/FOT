/**
 * СКУД: аналитика дисциплины (GET /api/skud/discipline).
 */
import { query } from '../config/postgres.js';
import { formatDateToISO } from '../utils/date.utils.js';
import type { IDisciplineParams, IDisciplineResult, IDisciplineViolation, IDailySummaryRow } from '../types/skud.types.js';
import { resolveSchedulesBulk, getEffectiveLateThreshold, getScheduleForDate, needsSkudCheck, countNormHoursForSchedule, loadCalendarMonth } from './schedule.service.js';

const LATE_THRESHOLD_DEFAULT = '09:00:00';
const WORK_NORM_HOURS_DEFAULT = 9;
const WORK_PRESENCE_HOURS_DEFAULT = 8;
const ABSENCE_THRESHOLD_HOURS = 3;

function timeToMin(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function fmtMinutes(min: number, sign = '+'): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0 && m > 0) return `${sign}${h}ч ${m}м`;
  if (h > 0) return `${sign}${h}ч`;
  return `${sign}${m} мин`;
}

export async function getDisciplineViolations(
  params: IDisciplineParams,
): Promise<IDisciplineResult> {
  const { startMonth, endMonth } = params;

  const normalizedStartMonth = startMonth <= endMonth ? startMonth : endMonth;
  const normalizedEndMonth = startMonth <= endMonth ? endMonth : startMonth;

  const [employees, departments] = await Promise.all([
    query<{
      id: number;
      full_name: string | null;
      position_id: string | null;
      org_department_id: string | null;
    }>(
      `SELECT id, full_name, position_id, org_department_id FROM employees
       WHERE is_archived = false AND employment_status = 'active'`,
    ),
    query<{ id: string; name: string }>('SELECT id, name FROM org_departments'),
  ]);

  if (!employees || employees.length === 0) {
    return { violations: [], employees: {}, departments: {} };
  }

  const activeEmpIds = employees.map(e => e.id);

  // Диапазон: первый день стартового месяца … последний день конечного.
  const rangeStart = `${normalizedStartMonth}-01`;
  const [endY, endM] = normalizedEndMonth.split('-').map(Number);
  const rangeEnd = formatDateToISO(new Date(endY, endM, 0));

  // Раньше: помесячная выборка с OFFSET-пагинацией по 1000 + фильтр активных
  // сотрудников в JS (большие OFFSET деградируют квадратично, на крупном
  // масштабе — десятки тысяч лишних строк в Node). Теперь: один запрос за весь
  // диапазон, фильтр активных сотрудников в SQL. Правила-eval ниже не изменены.
  const summaries = await query<IDailySummaryRow>(
    `SELECT employee_id, date, first_entry, last_exit, total_hours, is_present
     FROM skud_daily_summary
     WHERE is_present = true
       AND date >= $1 AND date <= $2
       AND (first_entry > $3 OR total_hours < $4)
       AND employee_id = ANY($5::bigint[])
     ORDER BY date ASC, employee_id ASC`,
    [rangeStart, rangeEnd, '09:00:00', 8, activeEmpIds],
  );

  const posIdSet = new Set(employees.map(e => e.position_id).filter((v): v is string => !!v));
  const posMap = new Map<string, string>();
  if (posIdSet.size > 0) {
    const positions = await query<{ id: string; name: string }>(
      'SELECT id, name FROM positions WHERE id = ANY($1::uuid[])',
      [[...posIdSet]],
    );
    for (const p of positions || []) posMap.set(p.id, p.name);
  }

  // Фактически отработанные часы за период (все present-дни, без violation-фильтра).
  const workedRows = await query<{ employee_id: number; worked: number | string | null }>(
    `SELECT employee_id, SUM(total_hours)::float AS worked
       FROM skud_daily_summary
      WHERE is_present = true AND date >= $1 AND date <= $2 AND employee_id = ANY($3::bigint[])
      GROUP BY employee_id`,
    [rangeStart, rangeEnd, activeEmpIds],
  );
  const workedMap = new Map<number, number>();
  for (const r of workedRows || []) workedMap.set(r.employee_id, Number(r.worked) || 0);

  const empListForSched = employees.map(e => ({ id: e.id as number }));
  const schedulesMap = await resolveSchedulesBulk(empListForSched, normalizedStartMonth + '-01');

  // Норма часов за период по графику сотрудника (схема резолвится на начало периода).
  const calendarsByKey = new Map<string, Awaited<ReturnType<typeof loadCalendarMonth>>>();
  const monthKeys: Array<{ year: number; month: number }> = [];
  {
    const [sy, sm] = normalizedStartMonth.split('-').map(Number);
    const [ey, em] = normalizedEndMonth.split('-').map(Number);
    let y = sy;
    let m = sm;
    while (y < ey || (y === ey && m <= em)) {
      monthKeys.push({ year: y, month: m });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  await Promise.all(monthKeys.map(async ({ year, month }) => {
    calendarsByKey.set(`${year}-${month}`, await loadCalendarMonth(year, month));
  }));
  const normMap = new Map<number, number>();
  for (const e of employees) {
    const sched = schedulesMap.get(e.id);
    if (!sched) continue;
    let total = 0;
    for (const { year, month } of monthKeys) {
      total += countNormHoursForSchedule(year, month, sched, calendarsByKey.get(`${year}-${month}`) ?? null);
    }
    normMap.set(e.id, total);
  }

  const empMap: Record<number, { full_name: string; position: string | null; department_id: string | null; worked_hours: number; norm_hours: number }> = {};
  for (const e of employees) {
    empMap[e.id] = {
      full_name: e.full_name || '',
      position: e.position_id ? posMap.get(e.position_id) || null : null,
      department_id: e.org_department_id || null,
      worked_hours: workedMap.get(e.id) ?? 0,
      norm_hours: normMap.get(e.id) ?? 0,
    };
  }

  const deptMap: Record<string, string> = {};
  for (const d of departments || []) {
    deptMap[d.id] = d.name;
  }

  const violations: IDisciplineViolation[] = [];
  const todayISO = formatDateToISO(new Date());

  for (const s of summaries || []) {
    if (!s.is_present) continue;
    const isToday = s.date === todayISO;

    const sched = schedulesMap.get(s.employee_id);

    if (sched) {
      const dateObj = new Date(s.date + 'T00:00:00');
      if (!needsSkudCheck(sched, dateObj)) continue;
    }

    const dateObj2 = new Date(s.date + 'T00:00:00');
    const dayParams = sched ? getScheduleForDate(sched, dateObj2) : null;
    const lateThreshold = sched ? getEffectiveLateThreshold(sched, dateObj2) : LATE_THRESHOLD_DEFAULT;
    const workPresenceHours = dayParams ? dayParams.work_hours : WORK_PRESENCE_HOURS_DEFAULT;
    const workStartMin = dayParams ? timeToMin(dayParams.work_start) : 9 * 60;
    const workNormHours = dayParams
      ? (timeToMin(dayParams.work_end) - timeToMin(dayParams.work_start)) / 60
      : WORK_NORM_HOURS_DEFAULT;

    // 1. Опоздание
    if (s.first_entry && s.first_entry > lateThreshold) {
      const [h, m] = s.first_entry.split(':').map(Number);
      const lateMin = (h * 60 + m) - workStartMin;
      violations.push({
        employee_id: s.employee_id,
        date: s.date,
        type: 'late',
        first_entry: s.first_entry,
        last_exit: s.last_exit,
        total_hours: s.total_hours,
        deviation: fmtMinutes(lateMin, '+'),
      });
    }

    let spanHours: number | null = null;
    if (s.first_entry && s.last_exit) {
      const [eh, em] = s.first_entry.split(':').map(Number);
      const [lh, lm] = s.last_exit.split(':').map(Number);
      spanHours = (lh * 60 + lm - eh * 60 - em) / 60;
    }

    // 2. Недоработка
    if (!isToday && s.total_hours !== null && s.total_hours < workPresenceHours) {
      const diffMin = Math.round((workPresenceHours - s.total_hours) * 60);
      violations.push({
        employee_id: s.employee_id,
        date: s.date,
        type: 'underwork',
        first_entry: s.first_entry,
        last_exit: s.last_exit,
        total_hours: s.total_hours,
        deviation: fmtMinutes(diffMin, '-'),
      });
    }

    // 3. Ранний уход
    if (!isToday && s.first_entry && s.last_exit) {
      const [eh, em] = s.first_entry.split(':').map(Number);
      const expectedLeave = eh * 60 + em + workNormHours * 60;
      const expectedH = Math.floor(expectedLeave / 60);
      const expectedM = expectedLeave % 60;
      const expectedStr = `${String(expectedH).padStart(2, '0')}:${String(expectedM).padStart(2, '0')}`;
      if (s.last_exit < expectedStr + ':00') {
        const earlyMin = Math.round(expectedLeave - (parseInt(s.last_exit.split(':')[0]) * 60 + parseInt(s.last_exit.split(':')[1])));
        violations.push({
          employee_id: s.employee_id,
          date: s.date,
          type: 'early',
          first_entry: s.first_entry,
          last_exit: s.last_exit,
          total_hours: s.total_hours,
          deviation: fmtMinutes(earlyMin, '-'),
        });
      }
    }

    // 4. Отсутствие >3ч
    if (!isToday && s.total_hours !== null && spanHours !== null) {
      const absenceHours = spanHours - s.total_hours;
      if (absenceHours > ABSENCE_THRESHOLD_HOURS) {
        const diffMin = Math.round(absenceHours * 60);
        violations.push({
          employee_id: s.employee_id,
          date: s.date,
          type: 'absence',
          first_entry: s.first_entry,
          last_exit: s.last_exit,
          total_hours: s.total_hours,
          deviation: `Отсутствие ${fmtMinutes(diffMin, '')}`,
        });
      }
    }
  }

  violations.sort((a, b) => b.date.localeCompare(a.date));

  return { violations, employees: empMap, departments: deptMap };
}
