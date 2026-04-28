/**
 * Сервис авто-генерации расчётных листков из данных табеля.
 */
import { supabase } from '../config/database.js';
import { buildAttendanceEntries } from './attendance.service.js';
import { resolveSchedulesBulk, resolveSchedulesForPeriod, countWorkingDaysForSchedule, loadCalendarMonth } from './schedule.service.js';

const WORKED_STATUSES = new Set(['work', 'manual', 'remote']);
const NDFL_RATE = 0.13;

interface IGeneratedPayslip {
  employee_id: number;
  full_name: string;
  salary: number;
  norm_days: number;
  worked_days: number;
  gross_amount: number;
  deductions: number;
  net_amount: number;
}

export const generatePayslipsForMonth = async (
  year: number,
  month: number,
  createdBy: string,
  departmentId?: string,
): Promise<{ generated: number; payslips: IGeneratedPayslip[] }> => {
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const startDate = `${period}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
  const midMonth = `${period}-15`;

  // 1. Получаем активных сотрудников с окладом
  let query = supabase
    .from('employees')
    .select('id, full_name, current_salary, org_department_id, work_category')
    .eq('employment_status', 'active');

  if (departmentId) {
    query = query.eq('org_department_id', departmentId);
  }

  const { data: employees, error: empErr } = await query;

  if (empErr) throw empErr;
  if (!employees || employees.length === 0) return { generated: 0, payslips: [] };

  // 2. Resolve расписания
  const scheduleMap = await resolveSchedulesBulk(
    employees.map(e => ({
      id: e.id as number,
      work_category: (e.work_category as string | null) || null,
    })),
    midMonth,
  );

  // 3. Загружаем календари и канонические attendance entries
  const [calendarMonth, dailySchedulesMap] = await Promise.all([
    loadCalendarMonth(year, month),
    resolveSchedulesForPeriod(
      employees.map(e => ({
        id: e.id as number,
        work_category: (e.work_category as string | null) || null,
      })),
      startDate,
      endDate,
    ),
  ]);

  const attendance = await buildAttendanceEntries({
    employees: employees.map(e => ({
      id: e.id as number,
      full_name: (e.full_name as string | null) || null,
      work_category: (e.work_category as string | null) || null,
    })),
    startDate,
    endDate,
    dailySchedulesMap,
    calendarMonth,
    todayStr: endDate,
  });

  // Группируем рабочие дни по сотруднику
  const workedMap = new Map<number, number>();
  for (const entry of attendance.entries) {
    if (WORKED_STATUSES.has(entry.status)) {
      workedMap.set(entry.employee_id, (workedMap.get(entry.employee_id) || 0) + 1);
    }
  }

  // 5. Генерируем расчётные листки
  const payslips: IGeneratedPayslip[] = [];
  const upsertRecords: Array<Record<string, unknown>> = [];

  for (const emp of employees) {
    const empId = emp.id as number;
    const salary = (emp.current_salary as number) ?? 0;
    if (salary <= 0) continue;

    const sched = scheduleMap.get(empId);
    const normDays = calendarMonth?.norm_days ?? (sched ? countWorkingDaysForSchedule(year, month, sched) : 22);
    const workedDays = workedMap.get(empId) || 0;

    if (workedDays === 0) continue;

    const gross = normDays > 0 ? (salary / normDays) * workedDays : 0;
    const deductions = Math.round(gross * NDFL_RATE * 100) / 100;
    const net = Math.round((gross - deductions) * 100) / 100;
    const grossRounded = Math.round(gross * 100) / 100;

    payslips.push({
      employee_id: empId,
      full_name: emp.full_name as string,
      salary,
      norm_days: normDays,
      worked_days: workedDays,
      gross_amount: grossRounded,
      deductions,
      net_amount: net,
    });

    upsertRecords.push({
      employee_id: empId,
      period,
      gross_amount: grossRounded,
      net_amount: net,
      deductions,
      details: { salary, norm_days: normDays, worked_days: workedDays, ndfl_rate: NDFL_RATE },
      created_by: createdBy,
    });
  }

  // 6. Upsert в payslips
  if (upsertRecords.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < upsertRecords.length; i += BATCH) {
      const batch = upsertRecords.slice(i, i + BATCH);
      const { error } = await supabase
        .from('payslips')
        .upsert(batch, { onConflict: 'employee_id,period' });
      if (error) throw error;
    }
  }

  return { generated: upsertRecords.length, payslips };
};
