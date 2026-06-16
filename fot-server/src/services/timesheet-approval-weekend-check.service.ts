import { query } from '../config/postgres.js';
import { loadCalendarMonth, resolveSchedulesForPeriod, isWorkingDay } from './schedule.service.js';
import {
  listEmployeeMembershipsForDepartmentPeriod,
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  type IMembershipWindow,
} from './timesheet-department-assignments.service.js';
import { countApprovalAttachmentsForApprovals } from './timesheet-approval-attachments.service.js';
import { computeMandatoryExemptions } from './timesheet-mandatory-weekend.service.js';
import { countCorrectionAttachments, listDaysWithTimeCorrectionMemo } from './correction-attachments.service.js';

export const MANAGER_OBJ_ROLE_CODE = 'manager_obj';

export interface IWeekendWorkCheck {
  requires: boolean;
  weekendDates: string[];
  weekendWorkDates: string[];
  /** Пары (сотрудник, дата) работы в выходной — для пер-дневной проверки служебок. */
  weekendWorkPairs: Array<{ employee_id: number; date: string }>;
}

export interface IManagerObjMemoCheck {
  required: boolean;
  satisfied: boolean;
  weekendWorkDates: string[];
}

const iterateDates = (startDate: string, endDate: string, cb: (iso: string) => void): void => {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const cursor = new Date(start);
  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    cb(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
};

/**
 * Для каждого сотрудника возвращает множество нерабочих по ЕГО графику дат
 * в диапазоне [startDate; endDate]. Использует isWorkingDay → учитывается
 * personal schedule (work_days, cycle), respects_holidays и mandatory_holidays.
 *
 * Дни, для которых график не разрешён (нет записи в resolveSchedulesForPeriod),
 * в Set не попадают — такие даты считаются «нет данных», а не «выходной».
 */
export async function getOffDatesByEmployee(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<Map<number, Set<string>>> {
  const result = new Map<number, Set<string>>();
  if (employeeIds.length === 0) return result;

  const rangeDates: string[] = [];
  iterateDates(startDate, endDate, (iso) => rangeDates.push(iso));

  const schedules = await resolveSchedulesForPeriod(
    employeeIds.map((id) => ({ id })),
    startDate,
    endDate,
  );

  const calendarCache = new Map<string, Awaited<ReturnType<typeof loadCalendarMonth>>>();
  const getCalendar = async (dateObj: Date) => {
    const key = `${dateObj.getFullYear()}-${dateObj.getMonth() + 1}`;
    if (!calendarCache.has(key)) {
      calendarCache.set(key, await loadCalendarMonth(dateObj.getFullYear(), dateObj.getMonth() + 1));
    }
    return calendarCache.get(key) ?? null;
  };

  for (const empId of employeeIds) {
    const dailyMap = schedules.get(empId);
    const offSet = new Set<string>();
    for (const iso of rangeDates) {
      const schedule = dailyMap?.get(iso);
      if (!schedule) continue;
      const dateObj = new Date(`${iso}T00:00:00`);
      const calendar = await getCalendar(dateObj);
      if (!isWorkingDay(schedule, dateObj, calendar)) {
        offSet.add(iso);
      }
    }
    result.set(empId, offSet);
  }

  return result;
}

/**
 * Выходной день определяется по ЛИЧНОМУ графику сотрудника (isWorkingDay):
 * нерабочий по его графику день — выходной, даже если по календарю это будний
 * (важно для сменных/цикличных графиков). Праздники производственного
 * календаря учитываются внутри isWorkingDay (respects_holidays).
 *
 * Если передан employeeIds — используется он (персональная подача руководителя
 * «по людям»); иначе тянется состав отдела через listEmployeeIdsAssignedToDepartmentPeriod.
 */
export async function checkWeekendWorkRequirement(params: {
  departmentId: string | null;
  startDate: string;
  endDate: string;
  employeeIds?: number[];
}): Promise<IWeekendWorkCheck> {
  const { departmentId, startDate, endDate } = params;

  // Окно членства в отделе по сотруднику: уволенный/переведённый числится в отделе
  // только с joined_date (вкл.) до transferred_out_date (искл.). Его «работа в выходной»
  // ПОСЛЕ выхода (СКУД уже на другом объекте) не должна требовать служебку в этом отделе.
  const membershipWindow = new Map<number, IMembershipWindow>();
  let employeeIds: number[];
  if (params.employeeIds) {
    employeeIds = [...new Set(params.employeeIds)].filter((id): id is number => Number.isInteger(id) && id > 0);
  } else if (departmentId) {
    const memberships = await listEmployeeMembershipsForDepartmentPeriod(departmentId, startDate, endDate);
    employeeIds = memberships.map(m => m.employee_id);
    for (const [id, w] of buildMembershipWindowMap(memberships)) membershipWindow.set(id, w);
  } else {
    employeeIds = [];
  }
  if (employeeIds.length === 0) {
    return { requires: false, weekendDates: [], weekendWorkDates: [], weekendWorkPairs: [] };
  }

  // Путь по employeeIds (подача «по людям») окна не имеет — там фильтр не применяем.
  const isWithinMembership = (empId: number, iso: string): boolean =>
    isWithinMembershipWindow(membershipWindow.get(empId), iso, 'always');

  const offByEmployee = await getOffDatesByEmployee(employeeIds, startDate, endDate);
  const allOffDates = new Set<string>();
  for (const set of offByEmployee.values()) {
    for (const iso of set) allOffDates.add(iso);
  }

  const weekendDates = [...allOffDates].sort();
  if (weekendDates.length === 0) {
    return { requires: false, weekendDates: [], weekendWorkDates: [], weekendWorkPairs: [] };
  }

  // Корректировки status='work' в выходной — это явно добавленный руководителем выход;
  // он не претендует на плановый слот и всегда требует служебку.
  // Day-level «Обнулить день» (source_type='manual', hours_override=0) — наоборот,
  // руководитель явно отверг СКУД-присутствие: такой день не считается работой в выходной.
  const adjPairs = new Set<string>();
  const zeroOffPairs = new Set<string>();
  const adjRows = await query<{ employee_id: number; work_date: string; status: string }>(
    `SELECT employee_id, work_date::text AS work_date, status, hours_override, source_type
       FROM attendance_adjustments
      WHERE employee_id = ANY($1::int[])
        AND work_date >= $2::date AND work_date <= $3::date
        AND (
          status = 'work'
          OR (source_type = 'manual' AND COALESCE(hours_override, 0) = 0 AND status <> 'work')
        )`,
    [employeeIds, startDate, endDate],
  );
  for (const row of adjRows) {
    const empId = Number(row.employee_id);
    const iso = String(row.work_date).slice(0, 10);
    if (row.status === 'work') {
      if (offByEmployee.get(empId)?.has(iso) && isWithinMembership(empId, iso)) {
        adjPairs.add(`${empId}|${iso}`);
      }
    } else {
      // Обнулённый день — вычитаем из СКУД-присутствия (off/membership-фильтр не нужен).
      zeroOffPairs.add(`${empId}|${iso}`);
    }
  }

  // Присутствие СКУД в выходной — кандидат на освобождение плановыми Сб/Вс графика.
  const skudPairs: Array<{ employee_id: number; date: string }> = [];
  const skudRows = await query<{ employee_id: number; date: string; total_minutes: number }>(
    `SELECT employee_id, date::text AS date, total_minutes
       FROM skud_daily_summary
      WHERE employee_id = ANY($1::int[])
        AND date >= $2::date AND date <= $3::date
        AND total_minutes > 0`,
    [employeeIds, startDate, endDate],
  );
  for (const row of skudRows) {
    const empId = Number(row.employee_id);
    const iso = String(row.date).slice(0, 10);
    if (zeroOffPairs.has(`${empId}|${iso}`)) continue;
    if (offByEmployee.get(empId)?.has(iso) && isWithinMembership(empId, iso)) {
      skudPairs.push({ employee_id: empId, date: iso });
    }
  }

  // Освобождаем первые expected_{saturdays|sundays}_per_month плановых выходных —
  // они входят в норму графика (например «5+2 (Линия С/О)» = 2 субботы/мес) и
  // служебки не требуют. Дни с work-корректировкой слот не занимают.
  const exemptions = await computeMandatoryExemptions(skudPairs, adjPairs);

  const weekendWorkDates = new Set<string>();
  const pairKeys = new Set<string>();
  for (const { employee_id, date } of skudPairs) {
    if (exemptions.has(`${employee_id}|${date}`)) continue;
    weekendWorkDates.add(date);
    pairKeys.add(`${employee_id}|${date}`);
  }
  for (const key of adjPairs) {
    weekendWorkDates.add(key.split('|')[1]!);
    pairKeys.add(key);
  }

  const weekendWorkPairs = [...pairKeys].map(key => {
    const [emp, date] = key.split('|');
    return { employee_id: Number(emp), date: date! };
  });

  const sortedWeekendWork = [...weekendWorkDates].sort();
  return {
    requires: sortedWeekendWork.length > 0,
    weekendDates,
    weekendWorkDates: sortedWeekendWork,
    weekendWorkPairs,
  };
}

/**
 * Чистая логика: по роли + найденным выходным дням + количеству вложений
 * вычисляет, нужна ли служебка и приложена ли она.
 * Вынесено отдельно от IO для удобного юнит-тестирования.
 */
export function evaluateManagerObjMemoRequirement(input: {
  weekendMemoRequired: boolean;
  weekendWorkDates: string[];
  attachmentCount: number;
}): IManagerObjMemoCheck {
  if (!input.weekendMemoRequired) {
    return { required: false, satisfied: true, weekendWorkDates: [] };
  }
  if (input.weekendWorkDates.length === 0) {
    return { required: false, satisfied: true, weekendWorkDates: [] };
  }
  return {
    required: true,
    satisfied: input.attachmentCount > 0,
    weekendWorkDates: [...input.weekendWorkDates].sort(),
  };
}

/**
 * Возвращает даты работы в выходной, у которых НЕТ приложенной служебки. День считается
 * покрытым, если хотя бы у одной его корректировки есть вложение (own-файл или файл из
 * связанной заявки) ЛИБО к time_correction-заявке этого дня прикреплён файл.
 */
async function listWeekendDaysWithoutCorrectionMemo(
  pairs: Array<{ employee_id: number; date: string }>,
): Promise<string[]> {
  if (pairs.length === 0) return [];
  const empIds = [...new Set(pairs.map(p => p.employee_id))];
  const dates = [...new Set(pairs.map(p => p.date))];

  const adjRows = await query<{
    id: number | string;
    employee_id: number | string;
    work_date: string;
    source_type: string;
    source_id: string | null;
  }>(
    `SELECT id, employee_id, work_date::text AS work_date, source_type, source_id
       FROM attendance_adjustments
      WHERE employee_id = ANY($1::int[]) AND work_date = ANY($2::date[])`,
    [empIds, dates],
  );
  const adjustments = adjRows.map(r => ({
    id: Number(r.id),
    employee_id: Number(r.employee_id),
    work_date: String(r.work_date).slice(0, 10),
    source_type: String(r.source_type),
    source_id: r.source_id ?? null,
  }));

  const counts = await countCorrectionAttachments(
    adjustments.map(a => ({ id: a.id, source_type: a.source_type, source_id: a.source_id })),
  );

  const coveredKeys = new Set<string>();
  for (const a of adjustments) {
    if ((counts.get(a.id) ?? 0) > 0) coveredKeys.add(`${a.employee_id}|${a.work_date}`);
  }
  // Файл на time_correction-заявке дня покрывает день, даже если у самой корректировки
  // (manual/manual_object) файла нет — служебку сотрудник прикрепляет к заявке.
  for (const key of await listDaysWithTimeCorrectionMemo(empIds, dates)) {
    coveredKeys.add(key);
  }

  const uncovered = new Set<string>();
  for (const p of pairs) {
    if (!coveredKeys.has(`${p.employee_id}|${p.date}`)) uncovered.add(p.date);
  }
  return [...uncovered].sort();
}

/**
 * IO-обёртка проверки служебки о работе в выходные.
 * Служебка считается приложенной, если:
 *   1) есть blanket-вложение на уровне подачи (entity='timesheet_approval') — покрывает
 *      весь период (как раньше, руководитель прикрепил служебку при подаче); ЛИБО
 *   2) у КАЖДОГО дня работы в выходной есть файл на самой корректировке дня
 *      (служебка, приложенная сотрудником/руководителем к корректировке).
 * Если флаг роли weekend_memo_required выключен — IO-запросы пропускаются.
 */
export async function checkManagerObjWeekendMemoRequirement(params: {
  weekendMemoRequired: boolean;
  departmentId: string | null;
  startDate: string;
  endDate: string;
  /**
   * Все строки подачи, консолидируемые этим сабмитом (reuseRow + точный черновик
   * диапазона + вытесняемые toDeleteIds): служебка могла быть загружена на любую из них.
   */
  approvalIds: number[];
  employeeIds?: number[];
}): Promise<IManagerObjMemoCheck> {
  if (!params.weekendMemoRequired) {
    return { required: false, satisfied: true, weekendWorkDates: [] };
  }

  const weekend = await checkWeekendWorkRequirement({
    departmentId: params.departmentId,
    startDate: params.startDate,
    endDate: params.endDate,
    employeeIds: params.employeeIds,
  });

  if (weekend.weekendWorkPairs.length === 0) {
    return { required: false, satisfied: true, weekendWorkDates: [] };
  }

  // Blanket-служебка на уровне подачи покрывает весь период.
  const approvalMemoCount = await countApprovalAttachmentsForApprovals(params.approvalIds);
  if (approvalMemoCount > 0) {
    return { required: true, satisfied: true, weekendWorkDates: weekend.weekendWorkDates };
  }

  // Иначе требуем служебку на корректировке каждого дня работы в выходной.
  const uncoveredDates = await listWeekendDaysWithoutCorrectionMemo(weekend.weekendWorkPairs);
  return {
    required: true,
    satisfied: uncoveredDates.length === 0,
    weekendWorkDates: uncoveredDates.length === 0 ? weekend.weekendWorkDates : uncoveredDates,
  };
}
