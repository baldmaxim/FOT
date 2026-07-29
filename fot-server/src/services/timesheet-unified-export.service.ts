import { query } from '../config/postgres.js';
import {
  fetchTimesheetDataForEmployees,
  sliceTimesheetDataByEmployees,
  type IDepartmentTimesheetData,
  type TimesheetExportRangeArg,
} from './timesheet-export.service.js';
import { buildUnified1CWorkbook } from './timesheet-1c-unified.service.js';
import { writeTimesheetWorkbookBuffer } from './timesheet-excel.service.js';

/** Бакет для сотрудников без определившегося подразделения за период. */
export const UNIFIED_EXPORT_NO_DEPARTMENT_NAME = 'Без названия';

export interface IUnified1CBuildParams {
  /** 'YYYY-MM' — единственный источник mon/year, чтобы файл нельзя было подписать чужим месяцем. */
  month: string;
  rangeArg: TimesheetExportRangeArg;
  /** employee_id → department_id (null = «Без названия»). */
  memberByEmp: Map<number, string | null>;
  /**
   * Начальники участков, которых нельзя выбрасывать фильтром «нет активности».
   * Приходит параметром, а не импортом: списки собирают контроллеры, а
   * timesheet-mass-export.controller уже импортирует из assigned-контроллера —
   * обратный импорт замкнул бы цикл ESM.
   */
  exemptEmployeeIds: Set<number>;
}

/**
 * Единый файл для 1С по готовой карте «сотрудник → подразделение».
 * Один bulk-прогон посещаемости на всех сотрудников, затем нарезка по отделам —
 * формат файла и правила отбора те же, что у выгрузки из «Табели HR».
 */
export async function buildUnified1CBuffer(params: IUnified1CBuildParams): Promise<Buffer> {
  const { month, rangeArg, memberByEmp, exemptEmployeeIds } = params;
  const year = Number.parseInt(month.slice(0, 4), 10);
  const mon = Number.parseInt(month.slice(5, 7), 10);

  const empIdsByDept = new Map<string | null, number[]>();
  for (const [empId, deptId] of memberByEmp) {
    const list = empIdsByDept.get(deptId);
    if (list) list.push(empId);
    else empIdsByDept.set(deptId, [empId]);
  }
  const allEmployeeIds = [...memberByEmp.keys()];

  // Названия отделов одним запросом; null-бакет в SQL не отправляем.
  const deptIds = [...empIdsByDept.keys()].filter((id): id is string => Boolean(id));
  const deptNameRows = deptIds.length > 0
    ? await query<{ id: string; name: string }>(
      'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
      [deptIds],
    )
    : [];
  const deptNameById = new Map(deptNameRows.map(r => [r.id, r.name]));

  // Один bulk-прогон на всех (один attendance/skud-скан). excludeZeroActivity убирает
  // не «тех, у кого нет СКУД», а тех, у кого hasRealActivity=false (учитывает
  // корректировки, статусы, ручные часы, объектную активность). exempt только
  // сохраняет уже загруженных — ростер не расширяет.
  const bulk = await fetchTimesheetDataForEmployees(
    month, allEmployeeIds, 'Сводный 1С', rangeArg, 'actual', true,
    { excludeZeroActivity: true, exemptEmployeeIds },
  );

  const collected: IDepartmentTimesheetData[] = [...empIdsByDept]
    .map(([deptId, empIds]) => sliceTimesheetDataByEmployees(
      bulk,
      empIds,
      (deptId && deptNameById.get(deptId)) || UNIFIED_EXPORT_NO_DEPARTMENT_NAME,
      deptId,
    ));

  const workbook = await buildUnified1CWorkbook(mon, year, collected);
  return writeTimesheetWorkbookBuffer(workbook);
}

export interface IStrictExportPeriod {
  month: string;
  year: number;
  mon: number;
  startDate: string;
  endDate: string;
  rangeArg: TimesheetExportRangeArg;
  /** '' для полного месяца, иначе '_1-15' / '_16-31'. */
  segmentSuffix: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Дата существует в календаре (отсекает 2026-02-30 и т.п.). */
const isRealDate = (value: string): boolean => {
  const [y, m, d] = value.split('-').map(part => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

/**
 * Строгий разбор периода экспорта. В отличие от resolveTimesheetDateRange, НЕ откатывается
 * молча на полный месяц: любая некорректность — ошибка, вызывающий отдаёт 400.
 */
export function parseStrictExportPeriod(
  body: { month?: unknown; from?: unknown; to?: unknown },
): { ok: true; period: IStrictExportPeriod } | { ok: false; error: string } {
  const { month, from, to } = body;
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, error: 'Параметр month обязателен (формат YYYY-MM)' };
  }
  const year = Number.parseInt(month.slice(0, 4), 10);
  const mon = Number.parseInt(month.slice(5, 7), 10);
  if (!Number.isFinite(year) || !Number.isFinite(mon) || mon < 1 || mon > 12) {
    return { ok: false, error: 'Некорректный месяц экспорта' };
  }

  if (typeof from !== 'string' || typeof to !== 'string'
    || !ISO_DATE.test(from) || !ISO_DATE.test(to)
    || !isRealDate(from) || !isRealDate(to)) {
    return { ok: false, error: 'Параметры from и to обязательны (формат YYYY-MM-DD)' };
  }
  if (!from.startsWith(`${month}-`) || !to.startsWith(`${month}-`)) {
    return { ok: false, error: 'Период должен находиться внутри выбранного месяца' };
  }
  if (from > to) {
    return { ok: false, error: 'Дата начала периода не может быть позже даты окончания' };
  }

  const daysInMonth = new Date(year, mon, 0).getDate();
  const startDay = Number.parseInt(from.slice(-2), 10);
  const endDay = Number.parseInt(to.slice(-2), 10);
  if (endDay > daysInMonth) {
    return { ok: false, error: 'Период должен находиться внутри выбранного месяца' };
  }
  const isFullMonth = startDay === 1 && endDay === daysInMonth;

  return {
    ok: true,
    period: {
      month,
      year,
      mon,
      startDate: from,
      endDate: to,
      rangeArg: { startDate: from, endDate: to },
      segmentSuffix: isFullMonth ? '' : `_${startDay}-${endDay}`,
    },
  };
}
