/**
 * Основа расчёта «К выплате (ФОТ)» к редакции закрытого табеля (миграция 330): по сотруднику и месяцу —
 * норма дней, рабочие дни для оклада, выходы в выходные и дни отсутствий. Графики меняют задним числом,
 * поэтому классификация дней и норма фиксируются в момент закрытия, а не считаются при чтении.
 *
 * Строится из сохранённых дней редакции (payload): одной функцией для закрытия и для дозаполнения. Дни —
 * правилом колонки «Дни» единого 1С (buildEmployeeRowsForOneC): округление часов, буквы, отсечка увольнения.
 * Рабочий для оклада — день графика или плановая Сб/Вс в квоте графика. Выход в выходной — день вне графика
 * со статусом work/remote/manual и часами > 0 (те же статусы, что требуют согласования выхода; несогласованные
 * часы выгрузка уже обнулила); РБ и УД в выходной — не выход: часов у них нет, согласовывать нечего.
 * Квота Сб/Вс графика (она в норме) сначала заполняется выходами — как в ЗУП: у «5+2» с одной субботой и двумя
 * согласованными выходами (Баранский, август 2026) 23 из 23 по окладу и один выход «Переработкой», а не 22 + 2.
 * Переработка в будни — только по корректировке с часами: часы 1С дня (при правке — округлённый факт) сверх
 * округлённой нормы дня, но не ниже дня производственного календаря — 8 ч, в предпраздничный 7 ч (решение
 * пользователя 27.10.2026): у графиков с короткой пятницей (7 ч) правка «8» в пятницу — не переработка, ЗУП её не
 * платит (Марухина, август 2026: четыре таких пятницы, переработки в ЗУП нет). СКУД сверх графика без правки 1С и так
 * срезает (Абраменко, август: 8,47 / 11 / 11 ч → 0 + 3 + 3 = 6 ч, как в ЗУП). «УУ» уходит в 1С буквой без часов,
 * но правка часов удалёнки — переработка по тому же порогу (Разаханов, 10.09.2026: «УУ» 9 ч → 1 ч; решение
 * пользователя 28.10.2026); дни оклада и «Дни» 1С от этого не меняются. ЗУП такие часы не видит.
 *
 * Запись — под SAVEPOINT: сбой основы не мешает закрыть табель и отдать его в 1С (основы нет — месяц
 * «Табель не закрыт»). Строки неизменяемы: новая revision — только при другом basis_hash.
 */
import crypto from 'node:crypto';
import * as Sentry from '@sentry/node';
import type { PoolClient } from 'pg';

import type { DbExecutor } from '../../config/postgres.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import { canonicalJson } from '../../utils/canonical-json.js';
import { getDayNormHours, isWorkingDay, loadCalendarMonth, resolveSchedulesForPeriod } from '../schedule.service.js';
import { compute1CDayHours, isStudentSchedule, isWorkedDayForOneC, STATUS_LABELS } from '../timesheet-excel.service.js';
import { computeExportWeekendExemptions } from '../timesheet-export.service.js';
import { buildFiredCutoffMap } from '../timesheet-fired-cutoff.service.js';
import type { ITimesheetVersionPayload, IVersionDayValue } from '../timesheet-version.service.js';

export type PayrollAbsenceStatus = 'vacation' | 'sick' | 'educational_leave' | 'unpaid';

export const PAYROLL_ABSENCE_STATUSES: readonly PayrollAbsenceStatus[] = ['vacation', 'sick', 'educational_leave', 'unpaid'];

export type PayrollAbsenceDays = Record<PayrollAbsenceStatus, number>;

export type PayrollBasisQuality = 'materialized' | 'reconstructed';

export type PayrollBasisReason = 'close' | 'rebuild' | 'backfill';

/**
 * Порог переработки в будни не ниже дня производственного календаря (40-часовая неделя), как ЗУП: 8 ч,
 * в предпраздничный день 7 ч. Смена длиннее (11–12 ч) — порог её норма.
 */
const CALENDAR_DAY_HOURS = 8;
const CALENDAR_PRE_HOLIDAY_HOURS = 7;

/** Выход в выходной оплачивается только за фактическую работу (WORKED_STATUSES_FOR_APPROVAL табеля). */
const DAYOFF_WORK_STATUSES = new Set(['work', 'remote', 'manual']);

const isAbsenceStatus = (status: string): status is PayrollAbsenceStatus =>
  (PAYROLL_ABSENCE_STATUSES as readonly string[]).includes(status);

export const emptyAbsenceDays = (): PayrollAbsenceDays => ({ vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 });

const pad2 = (value: number): string => String(value).padStart(2, '0');

const daysInMonth = (month: string): number => {
  const [year, mon] = month.split('-').map(Number);
  return new Date(year, mon, 0).getDate();
};

/** Месяцы YYYY-MM периода включительно. */
export const monthsInRange = (startDate: string, endDate: string): string[] => {
  const months: string[] = [];
  let [year, mon] = startDate.slice(0, 7).split('-').map(Number);
  const last = endDate.slice(0, 7);
  for (;;) {
    const month = `${year}-${pad2(mon)}`;
    months.push(month);
    if (month >= last) return months;
    mon += 1;
    if (mon > 12) { mon = 1; year += 1; }
  }
};

export interface IBasisDays {
  workdayDates: string[];
  dayoffDates: string[];
  absenceDays: PayrollAbsenceDays;
  /** Переработка в будни по корректировкам: дата → минуты. */
  overtimeMinutes: Record<string, number>;
}

export interface IClassifyBasisInput {
  employeeId: number;
  /** YYYY-MM: берутся только дни этого месяца. */
  month: string;
  days: Readonly<Record<string, Pick<IVersionDayValue, 'status' | 'hours' | 'hours_overridden'>>>;
  schedules: ReadonlyMap<string, IResolvedSchedule> | undefined;
  calendar: IProductionCalendarMonth | null;
  /** Плановые Сб/Вс в квоте графика — `${employeeId}|${date}` (computeExportWeekendExemptions). */
  plannedWeekendDays: ReadonlySet<string>;
  /** Первый день без работы уволенного; null — не уволен. */
  cutoff: string | null;
}

/** Дни сотрудника за месяц: рабочие для оклада, выходы в выходные, отсутствия. Правила — в шапке файла. */
export const classifyBasisDays = (input: IClassifyBasisInput): IBasisDays => {
  const workdayDates: string[] = [];
  const dayoffDates: string[] = [];
  const absenceDays = emptyAbsenceDays();
  const overtimeMinutes: Record<string, number> = {};
  let quotaUsed = 0;
  const dates = Object.keys(input.days).filter(date => date.startsWith(`${input.month}-`)).sort();
  for (const date of dates) {
    if (input.cutoff && date >= input.cutoff) continue;
    const day = input.days[date];
    if (isAbsenceStatus(day.status)) {
      absenceDays[day.status] += 1;
      continue;
    }
    const schedule = input.schedules?.get(date);
    const [year, mon, dom] = date.split('-').map(Number);
    const dateObj = new Date(year, mon - 1, dom);
    const hours = typeof day.hours === 'number' ? day.hours : 0;
    const dayNorm = schedule ? getDayNormHours(schedule, dateObj, input.calendar) : 0;
    const preHoliday = Boolean(input.calendar?.pre_holidays?.includes(date));
    // Буква (УУ, Н, В) уходит в 1С без часов — как в buildEmployeeRowsForOneC.
    const exportedHours = STATUS_LABELS[day.status] || hours <= 0.001
      ? 0
      : compute1CDayHours(hours, dayNorm, preHoliday, isStudentSchedule(schedule), Boolean(day.hours_overridden));
    if (!isWorkedDayForOneC(day.status, exportedHours)) continue;
    // Часы для переработки: у «УУ» с правкой — округлённая правка, хотя в 1С день уходит буквой.
    const overtimeHours = day.status === 'remote' && day.hours_overridden && hours > 0.001
      ? compute1CDayHours(hours, dayNorm, preHoliday, isStudentSchedule(schedule), true)
      : exportedHours;
    // Без графика выгрузка считает день рабочим — так же и здесь.
    if (!schedule || isWorkingDay(schedule, dateObj, input.calendar)) {
      workdayDates.push(date);
      // Порог — не ниже дня производственного календаря: короткая пятница графика (7 ч) с правкой 8 ч — не переработка.
      const overtimeFrom = Math.max(Math.round(dayNorm), preHoliday ? CALENDAR_PRE_HOLIDAY_HOURS : CALENDAR_DAY_HOURS);
      const extra = overtimeHours - overtimeFrom;
      if (schedule && day.hours_overridden && extra > 0) overtimeMinutes[date] = extra * 60;
    } else if (input.plannedWeekendDays.has(`${input.employeeId}|${date}`)) {
      workdayDates.push(date);
      quotaUsed += 1;
    } else if (DAYOFF_WORK_STATUSES.has(day.status) && hours > 0.001) {
      dayoffDates.push(date);
    }
  }
  // Свободная квота Сб/Вс графика последнего дня (как в норме) — первые выходы месяца.
  const last = input.schedules?.get(`${input.month}-${pad2(daysInMonth(input.month))}`);
  const quota = (last?.expected_saturdays_per_month ?? 0) + (last?.expected_sundays_per_month ?? 0);
  const intoQuota = dayoffDates.splice(0, Math.max(0, quota - quotaUsed));
  return { workdayDates: [...workdayDates, ...intoQuota].sort(), dayoffDates, absenceDays, overtimeMinutes };
};

/**
 * Норма дней месяца: дни, рабочие по графику своего дня (праздники учтены), + плановые Сб/Вс графика последнего
 * дня — как countNormHoursForSchedule. За весь месяц: приём и увольнение норму не режут. Нет графика хоть на один
 * день — норма производственного календаря (по найденным дням она бы занизилась); нет и её — null.
 */
export const countMonthNormDays = (
  schedules: ReadonlyMap<string, IResolvedSchedule> | undefined,
  month: string,
  calendar: IProductionCalendarMonth | null,
): number | null => {
  const [year, mon] = month.split('-').map(Number);
  const daily: IResolvedSchedule[] = [];
  for (let day = 1; day <= daysInMonth(month); day++) {
    const schedule = schedules?.get(`${month}-${pad2(day)}`);
    if (!schedule) return calendar?.norm_days ?? null;
    daily.push(schedule);
  }
  const workdays = daily.filter((schedule, index) => (
    isWorkingDay(schedule, new Date(year, mon - 1, index + 1), calendar)
  )).length;
  const last = daily[daily.length - 1];
  return workdays + (last?.expected_saturdays_per_month ?? 0) + (last?.expected_sundays_per_month ?? 0);
};

/**
 * Норма часов месяца в минутах — знаменатель часовой переработки. Как ЗУП — норма производственного календаря
 * (40-часовая неделя): у Абраменко в августе 2026 график с 7-часовой пятницей (164 ч), а ЗУП заплатил 6 ч ×
 * 250 000 / 168. Календаря нет — часы графика каждого дня + плановые Сб/Вс (как countNormHoursForSchedule); нет
 * графика хоть на день — null.
 */
export const countMonthNormMinutes = (
  schedules: ReadonlyMap<string, IResolvedSchedule> | undefined,
  month: string,
  calendar: IProductionCalendarMonth | null,
): number | null => {
  if (calendar && Number(calendar.norm_hours) > 0) return Math.round(Number(calendar.norm_hours) * 60);
  const [year, mon] = month.split('-').map(Number);
  let hours = 0;
  let last: IResolvedSchedule | undefined;
  for (let day = 1; day <= daysInMonth(month); day++) {
    last = schedules?.get(`${month}-${pad2(day)}`);
    if (!last) return null;
    hours += getDayNormHours(last, new Date(year, mon - 1, day), calendar);
  }
  const quota = (last?.expected_saturdays_per_month ?? 0) + (last?.expected_sundays_per_month ?? 0);
  return Math.round((hours + quota * (last?.work_hours ?? 0)) * 60);
};

export interface IPayrollBasisDraft extends IBasisDays {
  employeeId: number;
  /** YYYY-MM-01. */
  month: string;
  normDays: number | null;
  normMinutes: number | null;
}

/** Хэш содержимого основы: одинаковая основа повторного закрытия новой revision не даёт. */
export const computeBasisHash = (draft: IPayrollBasisDraft): string => crypto
  .createHash('sha256')
  .update(canonicalJson({
    normDays: draft.normDays,
    normMinutes: draft.normMinutes,
    workdayDates: draft.workdayDates,
    dayoffDates: draft.dayoffDates,
    absenceDays: draft.absenceDays,
    overtimeMinutes: draft.overtimeMinutes,
  }))
  .digest('hex');

/** Основа по каждому сотруднику редакции и каждому месяцу её периода — по графикам на сейчас. */
export const buildPayrollBasisDrafts = async (
  exec: DbExecutor,
  payload: ITimesheetVersionPayload,
): Promise<IPayrollBasisDraft[]> => {
  const employeeIds = payload.employees.map(employee => Number(employee.identity.employee_id));
  if (employeeIds.length === 0) return [];
  const employeeRows = (await exec.query<Record<string, unknown>>(
    `SELECT id, employment_status, dismissal_date, excluded_from_timesheet_date
       FROM employees WHERE id = ANY($1::int[])`,
    [employeeIds],
  )).rows;
  // Отсечка — та же формула и тот же старт, что у версии (buildTimesheetPayload).
  const cutoffs = buildFiredCutoffMap(employeeRows, payload.approval.start_date);

  const drafts: IPayrollBasisDraft[] = [];
  for (const month of monthsInRange(payload.approval.start_date, payload.approval.end_date)) {
    const [year, mon] = month.split('-').map(Number);
    // Клиент транзакции не выполняет запросы параллельно — по очереди.
    const schedules = await resolveSchedulesForPeriod(
      employeeIds.map(id => ({ id })), `${month}-01`, `${month}-${pad2(daysInMonth(month))}`, exec,
    );
    const calendar = await loadCalendarMonth(year, mon, exec);
    const plannedWeekendDays = await computeExportWeekendExemptions(employeeIds, year, mon, calendar, exec);
    for (const employee of payload.employees) {
      const employeeId = Number(employee.identity.employee_id);
      const employeeSchedules = schedules.get(employeeId);
      drafts.push({
        employeeId,
        month: `${month}-01`,
        normDays: countMonthNormDays(employeeSchedules, month, calendar),
        normMinutes: countMonthNormMinutes(employeeSchedules, month, calendar),
        ...classifyBasisDays({
          employeeId,
          month,
          days: employee.days ?? {},
          schedules: employeeSchedules,
          calendar,
          plannedWeekendDays,
          cutoff: cutoffs.get(employeeId) ?? null,
        }),
      });
    }
  }
  return drafts;
};

/**
 * Пишет основы редакции. changed — новая revision, только если основы нет или хэш другой (закрытие);
 * missing — только если основы сотрудника за месяц нет совсем (дозаполнение не трогает снятые при закрытии).
 * Возвращает число записанных строк.
 */
export const insertPayrollBasis = async (
  exec: DbExecutor,
  versionId: number,
  drafts: readonly IPayrollBasisDraft[],
  options: { quality: PayrollBasisQuality; reason: PayrollBasisReason; mode: 'changed' | 'missing' },
): Promise<number> => {
  if (drafts.length === 0) return 0;
  const latest = (await exec.query<{ employee_id: number; month: string; revision: number; basis_hash: string }>(
    `SELECT DISTINCT ON (employee_id, month) employee_id, to_char(month, 'YYYY-MM-DD') AS month, revision, basis_hash
       FROM timesheet_version_payroll_basis
      WHERE version_id = $1
      ORDER BY employee_id, month, revision DESC`,
    [versionId],
  )).rows;
  const latestByKey = new Map(latest.map(row => [`${row.employee_id}|${row.month}`, row]));

  const rows = [];
  for (const draft of drafts) {
    const previous = latestByKey.get(`${draft.employeeId}|${draft.month}`);
    const hash = computeBasisHash(draft);
    if (previous && (options.mode === 'missing' || previous.basis_hash === hash)) continue;
    rows.push({
      employee_id: draft.employeeId,
      month: draft.month,
      revision: (previous ? Number(previous.revision) : 0) + 1,
      basis_hash: hash,
      norm_days: draft.normDays,
      norm_minutes: draft.normMinutes,
      workday_dates: draft.workdayDates,
      dayoff_dates: draft.dayoffDates,
      absence_days: draft.absenceDays,
      overtime_minutes: draft.overtimeMinutes,
    });
  }
  if (rows.length === 0) return 0;
  await exec.query(
    `INSERT INTO timesheet_version_payroll_basis (
       version_id, employee_id, month, revision, basis_hash, norm_days, norm_minutes,
       workday_dates, dayoff_dates, absence_days, overtime_minutes, quality, reason
     )
     SELECT $1, r.employee_id, r.month, r.revision, r.basis_hash, r.norm_days, r.norm_minutes,
            ARRAY(SELECT jsonb_array_elements_text(r.workday_dates))::date[],
            ARRAY(SELECT jsonb_array_elements_text(r.dayoff_dates))::date[],
            r.absence_days, r.overtime_minutes, $3, $4
       FROM jsonb_to_recordset($2::jsonb) AS r(
         employee_id int, month date, revision int, basis_hash text, norm_days int, norm_minutes int,
         workday_dates jsonb, dayoff_dates jsonb, absence_days jsonb, overtime_minutes jsonb)
     ON CONFLICT (version_id, employee_id, month, revision) DO NOTHING`,
    [versionId, JSON.stringify(rows), options.quality, options.reason],
  );
  return rows.length;
};

/**
 * Работа с основой внутри транзакции закрытия: SAVEPOINT, ошибка — откат к нему и Sentry, закрытие идёт дальше.
 * Сам SAVEPOINT не удался — транзакции уже нет, писать нечего: та же ошибка всплывёт у закрытия.
 */
const withBasisSavepoint = async (client: PoolClient, label: string, work: () => Promise<void>): Promise<void> => {
  let savepoint = false;
  try {
    await client.query('SAVEPOINT payroll_basis');
    savepoint = true;
    await work();
    await client.query('RELEASE SAVEPOINT payroll_basis');
  } catch (error) {
    if (savepoint) {
      await client.query('ROLLBACK TO SAVEPOINT payroll_basis');
      await client.query('RELEASE SAVEPOINT payroll_basis');
    }
    console.error(`[payroll-basis] ${label}:`, error);
    Sentry.captureException(error, { tags: { area: 'payroll-basis' }, extra: { label } });
  }
};

/** Основа к редакции при утверждении/закрытии — по графикам на момент закрытия. */
export const writePayrollBasisForVersion = async (
  client: PoolClient,
  versionId: number,
  payload: ITimesheetVersionPayload,
): Promise<void> => withBasisSavepoint(client, `version ${versionId}`, async () => {
  const drafts = await buildPayrollBasisDrafts(client, payload);
  await insertPayrollBasis(client, versionId, drafts, { quality: 'materialized', reason: 'close', mode: 'changed' });
});

/**
 * Перенос основы в новую редакцию с теми же днями (пересборка объектов или без части сотрудников): последняя
 * revision каждого сотрудника и месяца прежней редакции — revision 1 новой, качество прежнее.
 */
export const copyPayrollBasis = async (
  client: PoolClient,
  fromVersionId: number,
  toVersionId: number,
  excludeEmployeeIds: readonly number[] = [],
): Promise<void> => withBasisSavepoint(client, `copy ${fromVersionId} → ${toVersionId}`, async () => {
  await client.query(
    `INSERT INTO timesheet_version_payroll_basis (
       version_id, employee_id, month, revision, basis_hash, norm_days, norm_minutes,
       workday_dates, dayoff_dates, absence_days, overtime_minutes, quality, reason
     )
     SELECT $2, b.employee_id, b.month, 1, b.basis_hash, b.norm_days, b.norm_minutes,
            b.workday_dates, b.dayoff_dates, b.absence_days, b.overtime_minutes, b.quality, 'rebuild'
       FROM (
         SELECT DISTINCT ON (employee_id, month) *
           FROM timesheet_version_payroll_basis
          WHERE version_id = $1 AND NOT (employee_id = ANY($3::int[]))
          ORDER BY employee_id, month, revision DESC
       ) b
     ON CONFLICT (version_id, employee_id, month, revision) DO NOTHING`,
    [fromVersionId, toVersionId, [...excludeEmployeeIds]],
  );
});
