import { describe, it, expect } from 'vitest';
import {
  EMPTY_TIMESHEET_OFFICE_DRAFT,
  buildTimesheetOfficePayload,
  isTimesheetOfficeRowChecked,
  type ITimesheetOfficeDraftSource,
} from './timesheetOfficeDraft';

const department = (over: Partial<ITimesheetOfficeDraftSource> = {}): ITimesheetOfficeDraftSource => ({
  departmentId: 'd-it',
  departmentOffice: false,
  rows: [
    { id: 1, personal_office: false },
    { id: 2, personal_office: true },
  ],
  ...over,
});
const draft = (employees: Array<[number, boolean]>, departmentWanted?: boolean) => ({
  department: departmentWanted,
  employees: new Map(employees),
});

describe('buildTimesheetOfficePayload', () => {
  it('нет отметок или отметки совпали с сервером — сохранять нечего', () => {
    expect(buildTimesheetOfficePayload(EMPTY_TIMESHEET_OFFICE_DRAFT, department())).toBeNull();
    expect(buildTimesheetOfficePayload(draft([[1, false], [2, true]], false), department())).toBeNull();
  });

  it('галочка строке — личный «Офис»; снятая у личного — вернуть', () => {
    expect(buildTimesheetOfficePayload(draft([[1, true], [2, false]]), department()))
      .toEqual({ employees: { add: [1], remove: [2] } });
  });

  it('«Офис» отделу в шапке — только отдел, личные отметки не отправляются', () => {
    expect(buildTimesheetOfficePayload(draft([[1, true], [2, false]], true), department()))
      .toEqual({ departments: { add: ['d-it'] } });
  });

  it('снятие «Офиса» с отдела вместе с личными отметками — одним запросом', () => {
    const source = department({ departmentOffice: true, rows: [{ id: 1, personal_office: false }] });
    expect(buildTimesheetOfficePayload(draft([[1, true]], false), source))
      .toEqual({ departments: { remove: ['d-it'] }, employees: { add: [1] } });
    // Отдел с «Офисом» остаётся — строки не меняются.
    expect(buildTimesheetOfficePayload(draft([[1, true]]), source)).toBeNull();
  });

  it('вкладка «Сотрудник»: одна строка; у отдела сотрудника «Офис» — не отправляется', () => {
    const employee = (locked: boolean): ITimesheetOfficeDraftSource => ({
      departmentId: null, departmentOffice: false, rows: [{ id: 7, personal_office: false, locked }],
    });
    expect(buildTimesheetOfficePayload(draft([[7, true]]), employee(false))).toEqual({ employees: { add: [7] } });
    expect(buildTimesheetOfficePayload(draft([[7, true]]), employee(true))).toBeNull();
  });
});

describe('isTimesheetOfficeRowChecked', () => {
  it('отметка важнее сервера; «Офис» отдела и locked — всегда отмечено', () => {
    const source = department();
    expect(isTimesheetOfficeRowChecked(source.rows[0], EMPTY_TIMESHEET_OFFICE_DRAFT, source)).toBe(false);
    expect(isTimesheetOfficeRowChecked(source.rows[1], EMPTY_TIMESHEET_OFFICE_DRAFT, source)).toBe(true);
    expect(isTimesheetOfficeRowChecked(source.rows[1], draft([[2, false]]), source)).toBe(false);
    expect(isTimesheetOfficeRowChecked(source.rows[0], draft([], true), source)).toBe(true);
    expect(isTimesheetOfficeRowChecked({ id: 9, personal_office: false, locked: true }, EMPTY_TIMESHEET_OFFICE_DRAFT, source)).toBe(true);
  });
});
