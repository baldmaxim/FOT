/**
 * Сервис авто-генерации расчётных листков из данных табеля.
 */
import { query, execute } from '../config/postgres.js';
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
  type EmpRow = {
    id: number;
    full_name: string | null;
    current_salary: number | null;
    org_department_id: string | null;
  };

  const employees = departmentId
    ? await query<EmpRow>(
        `SELECT id, full_name, current_salary, org_department_id
           FROM employees
          WHERE employment_status = 'active' AND org_department_id = $1`,
        [departmentId],
      )
    : await query<EmpRow>(
        `SELECT id, full_name, current_salary, org_department_id
           FROM employees
          WHERE employment_status = 'active'`,
      );

  if (employees.length === 0) return { generated: 0, payslips: [] };

  // 2. Resolve расписания
  const scheduleMap = await resolveSchedulesBulk(
    employees.map(e => ({ id: e.id })),
    midMonth,
  );

  // 3. Загружаем календари и канонические attendance entries
  const [calendarMonth, dailySchedulesMap] = await Promise.all([
    loadCalendarMonth(year, month),
    resolveSchedulesForPeriod(
      employees.map(e => ({ id: e.id })),
      startDate,
      endDate,
    ),
  ]);

  const attendance = await buildAttendanceEntries({
    employees: employees.map(e => ({
      id: e.id,
      full_name: e.full_name || null,
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
  const upsertRecords: Array<{
    employee_id: number;
    period: string;
    gross_amount: number;
    net_amount: number;
    deductions: number;
    details: Record<string, unknown>;
    created_by: string;
  }> = [];

  for (const emp of employees) {
    const empId = emp.id;
    const salary = emp.current_salary ?? 0;
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
      full_name: emp.full_name || '',
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
      const empIds = batch.map(r => r.employee_id);
      const periods = batch.map(r => r.period);
      const grosses = batch.map(r => r.gross_amount);
      const nets = batch.map(r => r.net_amount);
      const dedus = batch.map(r => r.deductions);
      const details = batch.map(r => JSON.stringify(r.details));
      const createdBys = batch.map(r => r.created_by);

      await execute(
        `INSERT INTO payslips
           (employee_id, period, gross_amount, net_amount, deductions, details, created_by)
         SELECT u.employee_id, u.period, u.gross_amount, u.net_amount, u.deductions, u.details::jsonb, u.created_by
           FROM unnest($1::bigint[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::text[], $7::uuid[])
             AS u(employee_id, period, gross_amount, net_amount, deductions, details, created_by)
         ON CONFLICT (employee_id, period) DO UPDATE SET
           gross_amount = EXCLUDED.gross_amount,
           net_amount = EXCLUDED.net_amount,
           deductions = EXCLUDED.deductions,
           details = EXCLUDED.details,
           created_by = EXCLUDED.created_by`,
        [empIds, periods, grosses, nets, dedus, details, createdBys],
      );
    }
  }

  return { generated: upsertRecords.length, payslips };
};
