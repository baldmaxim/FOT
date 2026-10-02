import { describe, it, expect } from 'vitest';
import type { TimesheetOfficeAssignment } from '../services/adminService';
import {
  EMPTY_TIMESHEET_OFFICE_DRAFT,
  buildTimesheetOfficePayload,
  isTimesheetOfficeRowChecked,
  toggledOfficeAssignment,
  type ITimesheetOfficeDraftSource,
} from './timesheetOfficeDraft';

const DOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const METRO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const department = (over: Partial<ITimesheetOfficeDraftSource> = {}): ITimesheetOfficeDraftSource => ({
  departmentId: 'd-it',
  departmentOffice: false,
  rows: [
    { id: 1, personal_assignment: null },
    { id: 2, personal_assignment: 'office' },
  ],
  ...over,
});
const draft = (employees: Array<[number, TimesheetOfficeAssignment]>, departmentWanted?: boolean) => ({
  department: departmentWanted,
  employees: new Map(employees),
});
const employeeTab = (assignment: TimesheetOfficeAssignment): ITimesheetOfficeDraftSource => ({
  departmentId: null, departmentOffice: false, rows: [{ id: 7, personal_assignment: assignment }],
});

describe('buildTimesheetOfficePayload', () => {
  it('нет отметок или отметки совпали с сервером — сохранять нечего', () => {
    expect(buildTimesheetOfficePayload(EMPTY_TIMESHEET_OFFICE_DRAFT, department())).toBeNull();
    expect(buildTimesheetOfficePayload(draft([[1, null], [2, 'office']], false), department())).toBeNull();
  });

  it('галочка строке — личный «Офис»; снятая у личного — вернуть', () => {
    expect(buildTimesheetOfficePayload(draft([[1, 'office'], [2, null]]), department()))
      .toEqual({ employees: { add: [1], remove: [2] } });
  });

  it('«Офис» отделу в шапке — только отдел, личные отметки не отправляются', () => {
    expect(buildTimesheetOfficePayload(draft([[1, 'office'], [2, null]], true), department()))
      .toEqual({ departments: { add: ['d-it'] } });
  });

  it('снятие «Офиса» с отдела вместе с личными отметками — одним запросом', () => {
    const source = department({ departmentOffice: true, rows: [{ id: 1, personal_assignment: null }] });
    expect(buildTimesheetOfficePayload(draft([[1, 'office']], false), source))
      .toEqual({ departments: { remove: ['d-it'] }, employees: { add: [1] } });
    // Отдел с «Офисом» остаётся — строки не меняются.
    expect(buildTimesheetOfficePayload(draft([[1, 'office']]), source)).toBeNull();
  });

  it('вкладка «Сотрудник»: объект — objects, «Офис» — add, «Не назначено» — remove', () => {
    expect(buildTimesheetOfficePayload(draft([[7, DOM]]), employeeTab(null))).toEqual({ employees: { objects: [{ id: 7, object_id: DOM }] } });
    expect(buildTimesheetOfficePayload(draft([[7, 'office']]), employeeTab(DOM))).toEqual({ employees: { add: [7] } });
    expect(buildTimesheetOfficePayload(draft([[7, METRO]]), employeeTab(DOM))).toEqual({ employees: { objects: [{ id: 7, object_id: METRO }] } });
    expect(buildTimesheetOfficePayload(draft([[7, null]]), employeeTab(DOM))).toEqual({ employees: { remove: [7] } });
  });

  it('вкладка «Сотрудник»: выбрали то же, что на сервере, — сохранять нечего', () => {
    expect(buildTimesheetOfficePayload(draft([[7, DOM]]), employeeTab(DOM))).toBeNull();
    expect(buildTimesheetOfficePayload(draft([[7, null]]), employeeTab(null))).toBeNull();
  });
});

describe('isTimesheetOfficeRowChecked', () => {
  it('отметка важнее сервера; «Офис» отдела — у всех без личного назначения; объект — не «Офис»', () => {
    const source = department();
    expect(isTimesheetOfficeRowChecked(source.rows[0], EMPTY_TIMESHEET_OFFICE_DRAFT, source)).toBe(false);
    expect(isTimesheetOfficeRowChecked(source.rows[1], EMPTY_TIMESHEET_OFFICE_DRAFT, source)).toBe(true);
    expect(isTimesheetOfficeRowChecked(source.rows[1], draft([[2, null]]), source)).toBe(false);
    expect(isTimesheetOfficeRowChecked(source.rows[0], draft([], true), source)).toBe(true);
    expect(isTimesheetOfficeRowChecked({ id: 9, personal_assignment: DOM }, EMPTY_TIMESHEET_OFFICE_DRAFT, source)).toBe(false);
  });

  it('назначенный объект главнее «Офиса» отдела: и при «Офисе» отдела галочки нет', () => {
    const source = department({ departmentOffice: true, rows: [{ id: 9, personal_assignment: DOM }, { id: 10, personal_assignment: null }] });
    expect(isTimesheetOfficeRowChecked(source.rows[0], EMPTY_TIMESHEET_OFFICE_DRAFT, source)).toBe(false);
    expect(isTimesheetOfficeRowChecked(source.rows[1], EMPTY_TIMESHEET_OFFICE_DRAFT, source)).toBe(true);
  });
});

describe('toggledOfficeAssignment', () => {
  it('«Офис» ставит; снятие возвращает прежнее: объект остаётся, личный «Офис» снимается', () => {
    const pinned = { id: 3, personal_assignment: DOM };
    expect(toggledOfficeAssignment(pinned, EMPTY_TIMESHEET_OFFICE_DRAFT)).toBe('office');
    expect(toggledOfficeAssignment(pinned, draft([[3, 'office']]))).toBe(DOM);
    expect(toggledOfficeAssignment({ id: 2, personal_assignment: 'office' }, EMPTY_TIMESHEET_OFFICE_DRAFT)).toBeNull();
    // Снятая галочка у объекта — запрос пустой: объект как был.
    const source = department({ rows: [pinned] });
    expect(buildTimesheetOfficePayload(draft([[3, toggledOfficeAssignment(pinned, draft([[3, 'office']]))]]), source)).toBeNull();
  });
});
