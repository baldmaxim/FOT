import type { ITimesheetOfficeUpdate, TimesheetOfficeAssignment } from '../services/adminService';

/** Несохранённые отметки окна «Режим табелирования»: желаемое состояние, а не действия. */
export interface ITimesheetOfficeDraft {
  /** «Офис» выбранному отделу; undefined — не трогали. */
  department?: boolean;
  /** Личное назначение по сотрудникам: «Офис», объект или null — снять; нет ключа — не трогали. */
  employees: ReadonlyMap<number, TimesheetOfficeAssignment>;
}

export interface ITimesheetOfficeDraftRow {
  id: number;
  /** Личное назначение по данным сервера. */
  personal_assignment: TimesheetOfficeAssignment;
}

export interface ITimesheetOfficeDraftSource {
  /** Выбранный отдел (вкладка «Отдел»); null — вкладка «Сотрудник». */
  departmentId: string | null;
  /** «Офис» отдела по данным сервера. */
  departmentOffice: boolean;
  rows: readonly ITimesheetOfficeDraftRow[];
}

export const EMPTY_TIMESHEET_OFFICE_DRAFT: ITimesheetOfficeDraft = { employees: new Map() };

/** «Офис» отделу с учётом отметки в шапке. */
export const draftDepartmentOffice = (draft: ITimesheetOfficeDraft, source: ITimesheetOfficeDraftSource): boolean =>
  source.departmentId !== null && (draft.department ?? source.departmentOffice);

/** Назначение строки: отметка, иначе состояние сервера. */
export const draftAssignment = (row: ITimesheetOfficeDraftRow, draft: ITimesheetOfficeDraft): TimesheetOfficeAssignment =>
  draft.employees.has(row.id) ? draft.employees.get(row.id) ?? null : row.personal_assignment;

/**
 * Галочка «Офис» строки: личный «Офис», а без личного назначения — «Офис» отдела. Назначенный
 * лично объект главнее отдела — у такой строки галочки нет.
 */
export const isTimesheetOfficeRowChecked = (
  row: ITimesheetOfficeDraftRow,
  draft: ITimesheetOfficeDraft,
  source: ITimesheetOfficeDraftSource,
): boolean => {
  const assignment = draftAssignment(row, draft);
  return assignment === 'office' || (assignment === null && draftDepartmentOffice(draft, source));
};

/**
 * Клик по «Офис» строки (вкладка «Отдел»): поставить «Офис»; снять — вернуть то, что было на
 * сервере (назначенный объект остаётся, личный «Офис» снимается).
 */
export const toggledOfficeAssignment = (
  row: ITimesheetOfficeDraftRow,
  draft: ITimesheetOfficeDraft,
): TimesheetOfficeAssignment => {
  if (draftAssignment(row, draft) !== 'office') return 'office';
  return row.personal_assignment === 'office' ? null : row.personal_assignment;
};

/**
 * Запрос «Сохранить»: разница отметок с сервером. Пока отделу ставится (или остаётся) «Офис»,
 * строки вкладки «Отдел» заблокированы и личные отметки не отправляются; назначения лично
 * правило отдела и так не трогает. null — сохранять нечего.
 */
export const buildTimesheetOfficePayload = (
  draft: ITimesheetOfficeDraft,
  source: ITimesheetOfficeDraftSource,
): ITimesheetOfficeUpdate | null => {
  const payload: ITimesheetOfficeUpdate = {};
  if (source.departmentId !== null && draft.department !== undefined && draft.department !== source.departmentOffice) {
    payload.departments = draft.department ? { add: [source.departmentId] } : { remove: [source.departmentId] };
  }
  if (!draftDepartmentOffice(draft, source)) {
    const add: number[] = [];
    const remove: number[] = [];
    const objects: Array<{ id: number; object_id: string }> = [];
    for (const row of source.rows) {
      if (!draft.employees.has(row.id)) continue;
      const wanted = draftAssignment(row, draft);
      if (wanted === row.personal_assignment) continue;
      if (wanted === 'office') add.push(row.id);
      else if (wanted === null) remove.push(row.id);
      else objects.push({ id: row.id, object_id: wanted });
    }
    if (add.length > 0 || remove.length > 0 || objects.length > 0) {
      payload.employees = {
        ...(add.length > 0 ? { add } : {}),
        ...(remove.length > 0 ? { remove } : {}),
        ...(objects.length > 0 ? { objects } : {}),
      };
    }
  }
  return payload.departments || payload.employees ? payload : null;
};
