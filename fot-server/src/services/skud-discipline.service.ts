/**
 * СКУД: аналитика дисциплины (GET /api/skud/discipline).
 */
import { supabase } from '../config/database.js';
import { formatDateToISO } from '../utils/date.utils.js';
import type { IDisciplineParams, IDisciplineResult, IDisciplineViolation, IDailySummaryRow } from '../types/skud.types.js';

const LATE_THRESHOLD = '09:00:00';
const WORK_NORM_HOURS = 9;
const WORK_PRESENCE_HOURS = 8;
const ABSENCE_THRESHOLD_HOURS = 3;

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
  const { organizationId, startMonth, endMonth } = params;

  const normalizedStartMonth = startMonth <= endMonth ? startMonth : endMonth;
  const normalizedEndMonth = startMonth <= endMonth ? endMonth : startMonth;

  // --- Параллельные запросы ---
  // Запрашиваем помесячно, чтобы не упереться в Supabase max_rows (10000)
  const fetchSummaryPages = async (): Promise<IDailySummaryRow[]> => {
    const PAGE_SIZE = 1000;
    const rows: IDailySummaryRow[] = [];
    let [curY, curM] = normalizedStartMonth.split('-').map(Number);
    const [endY, endM] = normalizedEndMonth.split('-').map(Number);

    while (curY < endY || (curY === endY && curM <= endM)) {
      const monthStart = `${curY}-${String(curM).padStart(2, '0')}-01`;
      const monthEnd = formatDateToISO(new Date(curY, curM, 0));
      let off = 0;

      while (true) {
        let q = supabase
          .from('skud_daily_summary')
          .select('employee_id, date, first_entry, last_exit, total_hours, is_present')
          .eq('is_present', true)
          .gte('date', monthStart)
          .lte('date', monthEnd)
          .or('first_entry.gt.09:00:00,total_hours.lt.8')
          .order('date', { ascending: true })
          .range(off, off + PAGE_SIZE - 1);
        if (organizationId) q = q.eq('organization_id', organizationId);
        const { data: page, error } = await q;
        if (error) throw error;
        if (!page || page.length === 0) break;
        rows.push(...(page as IDailySummaryRow[]));
        if (page.length < PAGE_SIZE) break;
        off += PAGE_SIZE;
      }

      curM++;
      if (curM > 12) { curM = 1; curY++; }
    }
    return rows;
  };

  let empQuery = supabase
    .from('employees')
    .select('id, full_name, position_id, org_department_id')
    .eq('is_archived', false)
    .eq('employment_status', 'active');
  if (organizationId) empQuery = empQuery.eq('organization_id', organizationId);

  let deptQuery = supabase.from('org_departments').select('id, name');
  if (organizationId) deptQuery = deptQuery.eq('organization_id', organizationId);

  const [empResult, deptResult, allSummaryRows] = await Promise.all([
    empQuery,
    deptQuery,
    fetchSummaryPages(),
  ]);

  const employees = empResult.data;
  const departments = deptResult.data;

  if (!employees || employees.length === 0) {
    return { violations: [], employees: {}, departments: {} };
  }

  // Фильтрация summary по активным сотрудникам
  const empIdSet = new Set(employees.map(e => e.id));
  const summaries = allSummaryRows.filter(s => empIdSet.has(s.employee_id));

  // Позиции
  const posIdSet = new Set(employees.map(e => e.position_id).filter(Boolean));
  const posMap = new Map<number, string>();
  if (posIdSet.size > 0) {
    const { data: positions } = await supabase.from('positions').select('id, name').in('id', [...posIdSet]);
    for (const p of positions || []) posMap.set(p.id, p.name);
  }

  const empMap: Record<number, { full_name: string; position: string | null; department_id: string | null }> = {};
  for (const e of employees) {
    empMap[e.id] = {
      full_name: e.full_name || '',
      position: e.position_id ? posMap.get(e.position_id) || null : null,
      department_id: e.org_department_id || null,
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

    // 1. Опоздание
    if (s.first_entry && s.first_entry > LATE_THRESHOLD) {
      const [h, m] = s.first_entry.split(':').map(Number);
      const lateMin = (h * 60 + m) - 9 * 60;
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

    // Span (от первого входа до последнего выхода)
    let spanHours: number | null = null;
    if (s.first_entry && s.last_exit) {
      const [eh, em] = s.first_entry.split(':').map(Number);
      const [lh, lm] = s.last_exit.split(':').map(Number);
      spanHours = (lh * 60 + lm - eh * 60 - em) / 60;
    }

    // 2. Недоработка (не для сегодня — день ещё не завершён)
    if (!isToday && s.total_hours !== null && s.total_hours < WORK_PRESENCE_HOURS) {
      const diffMin = Math.round((WORK_PRESENCE_HOURS - s.total_hours) * 60);
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

    // 3. Ранний уход (не для сегодня — день ещё не завершён)
    if (!isToday && s.first_entry && s.last_exit) {
      const [eh, em] = s.first_entry.split(':').map(Number);
      const expectedLeave = eh * 60 + em + WORK_NORM_HOURS * 60;
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

    // 4. Отсутствие >3ч (не для сегодня — день ещё не завершён)
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

  // Сортировка: новые даты сверху
  violations.sort((a, b) => b.date.localeCompare(a.date));

  return { violations, employees: empMap, departments: deptMap };
}
