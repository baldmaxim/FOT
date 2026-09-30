import type { ITimesheetOfficeUpdate } from '../services/adminService';

/** Несохранённые отметки окна «Режим табелирования»: желаемое состояние, а не действия. */
export interface ITimesheetOfficeDraft {
  /** «Офис» выбранному отделу; undefined — не трогали. */
  department?: boolean;
  /** Личный «Офис» по сотрудникам; нет ключа — не трогали. */
  employees: ReadonlyMap<number, boolean>;
}

export interface ITimesheetOfficeDraftRow {
  id: number;
  personal_office: boolean;
  /** У отдела сотрудника «Офис» (вкладка «Сотрудник»): строка отмечена и не меняется. */
  locked?: boolean;
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

/** Галочка строки: «Офис» отдела (отдел главнее), иначе отметка или состояние сервера. */
export const isTimesheetOfficeRowChecked = (
  row: ITimesheetOfficeDraftRow,
  draft: ITimesheetOfficeDraft,
  source: ITimesheetOfficeDraftSource,
): boolean =>
  draftDepartmentOffice(draft, source) || row.locked === true || (draft.employees.get(row.id) ?? row.personal_office);

/**
 * Запрос «Сохранить»: разница отметок с сервером. Пока отделу ставится (или остаётся) «Офис»,
 * личные отметки не отправляются — у сотрудников отдела с «Офисом» личного не бывает.
 * null — сохранять нечего.
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
    for (const row of source.rows) {
      const wanted = draft.employees.get(row.id);
      if (row.locked || wanted === undefined || wanted === row.personal_office) continue;
      (wanted ? add : remove).push(row.id);
    }
    if (add.length > 0 || remove.length > 0) {
      payload.employees = {
        ...(add.length > 0 ? { add } : {}),
        ...(remove.length > 0 ? { remove } : {}),
      };
    }
  }
  return payload.departments || payload.employees ? payload : null;
};
