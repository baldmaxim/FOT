import type {
  ITimesheetSalaryObject,
  ITimesheetSalaryObjectMember,
  ITimesheetSalaryResponse,
  ITimesheetSalaryRow,
} from '../types/timesheet';

/** «Не определён» — один ключ у расчёта и у живого табеля (UNKNOWN_OBJECT_KEY бэкенда). */
export const SALARY_UNKNOWN_OBJECT_KEY = '__unknown_object__';

/** Группа сетки «По объектам»: ключ объекта, синтетическая ли («Не определён / без объекта»), чьи в ней строки. */
export interface ISalaryOverlayGroup {
  object_key: string;
  isSynthetic: boolean;
  employeeIds: readonly number[];
}

/** Как расчёт «Зарплаты по объектам» ложится на сетку «По объектам». */
export interface ISalaryObjectsOverlay {
  /** Группа сетки → объект расчёта: его «Выработка, ₽» и доли строк группы. */
  objectByGroup: ReadonlyMap<string, ITimesheetSalaryObject>;
  /** Участники объекта расчёта, которых нет в строках его группы, — строки «только в расчёте» под группой. */
  extraMembersByGroup: ReadonlyMap<string, ITimesheetSalaryObjectMember[]>;
  /** Объекты расчёта без группы сетки («Текущая деятельность», закреплённый объект) — свои группы ниже. */
  unmatched: ITimesheetSalaryObject[];
}

/**
 * Сопоставление по паре (объект, сотрудник): каждая доля расчёта показывается ровно один раз — в строке сетки, строкой
 * «только в расчёте» под группой или в группе «только в расчёте». Объект ↔ группа с тем же ключом; «Не определён»
 * без своей группы — синтетическая «Не определён / без объекта» (её строки получают доли только от него).
 */
export const buildSalaryObjectsOverlay = (
  groups: readonly ISalaryOverlayGroup[],
  objects: readonly ITimesheetSalaryObject[],
): ISalaryObjectsOverlay => {
  const objectByKey = new Map(objects.map(object => [object.object_key, object]));
  const realKeys = new Set(groups.filter(group => !group.isSynthetic).map(group => group.object_key));
  const objectByGroup = new Map<string, ITimesheetSalaryObject>();
  const extraMembersByGroup = new Map<string, ITimesheetSalaryObjectMember[]>();
  const matched = new Set<string>();
  for (const group of groups) {
    const key = group.isSynthetic
      ? (realKeys.has(SALARY_UNKNOWN_OBJECT_KEY) ? null : SALARY_UNKNOWN_OBJECT_KEY)
      : group.object_key;
    const object = key === null ? undefined : objectByKey.get(key);
    if (!object || matched.has(object.object_key)) continue;
    matched.add(object.object_key);
    objectByGroup.set(group.object_key, object);
    const shown = new Set(group.employeeIds);
    const extra = object.members.filter(member => !shown.has(member.employee_id));
    if (extra.length > 0) extraMembersByGroup.set(group.object_key, extra);
  }
  return {
    objectByGroup,
    extraMembersByGroup,
    unmatched: objects.filter(object => !matched.has(object.object_key)),
  };
};

/** Клетка строки «только в расчёте»: часы расчёта за день целыми; их нет — что в табеле (буква, «—», пусто). */
export const salaryCalcCellText = (hours: number | undefined, timesheetText: string): string => (
  hours === undefined ? timesheetText : String(Math.round(hours))
);

/** «Итого по бригаде»: с «Все сотрудники» — весь состав, без — только те, у кого есть часы на объектах. */
export const salaryTotalRows = (
  rows: readonly ITimesheetSalaryRow[],
  data: ITimesheetSalaryResponse,
  showAllEmployees: boolean,
): ITimesheetSalaryRow[] => (showAllEmployees
  ? [...rows]
  : rows.filter(row => (data.objects ?? []).some(object => object.members.some(member => (
    member.employee_id === row.employee_id && Object.keys(member.days).length > 0
  )))));
