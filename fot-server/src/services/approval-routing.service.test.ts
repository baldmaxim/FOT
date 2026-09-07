import { beforeEach, describe, expect, it, vi } from 'vitest';

// БД и тяжёлые зависимости мокаем — тест чисто логический, без записи.
const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { schedMock, isWorkingDayMock, calMock } = vi.hoisted(() => ({
  schedMock: vi.fn(),
  isWorkingDayMock: vi.fn(),
  calMock: vi.fn(),
}));
vi.mock('./schedule.service.js', () => ({
  resolveSchedulesForPeriod: schedMock,
  isWorkingDay: isWorkingDayMock,
  loadCalendarMonth: calMock,
}));

const { directMgrsMock } = vi.hoisted(() => ({ directMgrsMock: vi.fn() }));
vi.mock('./employee-direct-reports.service.js', () => ({
  getActiveDirectManagersFor: directMgrsMock,
}));

// listEffectiveDepartmentManagers проверяет право роли на /timesheet:edit —
// в юнит-тесте маршрутизации считаем, что право есть у всех.
vi.mock('./access-control.service.js', () => ({ hasPageEdit: vi.fn(async () => true) }));

/** Строка employee_department_access в форме, которую отдаёт запрос руководителей. */
const head = (employeeId: number, departmentId: string) =>
  ({ employee_id: employeeId, department_id: departmentId, role_code: 'manager', is_admin: false });

import {
  resolveResponsibleEmployeeIdsForRows,
  resolveResponsibleEmployeeIdsByEmployee,
} from './approval-routing.service.js';

const WEEKEND = '2026-06-06'; // суббота
const WEEKDAY = '2026-06-08'; // понедельник

// Расписание-заглушка: помечаем выходной флагом на конкретную дату.
function buildSchedules(entries: Array<{ emp: number; date: string; weekend: boolean }>) {
  const map = new Map<number, Map<string, { weekend: boolean }>>();
  for (const e of entries) {
    if (!map.has(e.emp)) map.set(e.emp, new Map());
    map.get(e.emp)!.set(e.date, { weekend: e.weekend });
  }
  return map;
}

beforeEach(() => {
  vi.clearAllMocks();
  calMock.mockResolvedValue(null);
  // isWorkingDay(schedule) → рабочий, если НЕ помечен weekend.
  isWorkingDayMock.mockImplementation((schedule: { weekend: boolean }) => !schedule?.weekend);
});

describe('resolveResponsibleEmployeeIdsForRows', () => {
  it('выходной + назначение по отделу → ответственный отдела', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('weekend_approval_assignments')) {
        return [{ responsible_employee_id: 100, target_department_id: 'D1', target_employee_id: null }];
      }
      return [];
    });
    schedMock.mockResolvedValue(buildSchedules([{ emp: 1, date: WEEKEND, weekend: true }]));
    directMgrsMock.mockResolvedValue(new Map());

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 11, employee_id: 1, work_date: WEEKEND, org_department_id: 'D1' },
    ]);
    expect(res.get(11)).toEqual([100]);
  });

  it('выходной без назначения → пусто (fallback на админа решает контроллер)', async () => {
    pgQuery.mockImplementation(async () => []);
    schedMock.mockResolvedValue(buildSchedules([{ emp: 2, date: WEEKEND, weekend: true }]));
    directMgrsMock.mockResolvedValue(new Map());

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 22, employee_id: 2, work_date: WEEKEND, org_department_id: 'D2' },
    ]);
    expect(res.get(22)).toEqual([]);
  });

  it('выходной: приоритет привязки по сотруднику над отделом', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('weekend_approval_assignments')) {
        return [
          { responsible_employee_id: 600, target_department_id: null, target_employee_id: 6 },
          { responsible_employee_id: 601, target_department_id: 'D6', target_employee_id: null },
        ];
      }
      return [];
    });
    schedMock.mockResolvedValue(buildSchedules([{ emp: 6, date: WEEKEND, weekend: true }]));
    directMgrsMock.mockResolvedValue(new Map());

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 66, employee_id: 6, work_date: WEEKEND, org_department_id: 'D6' },
    ]);
    expect(res.get(66)).toEqual([600]);
  });

  it('будний день: руководитель отдела важнее «Человека»', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      // Табель ведёт руководитель отдела — корректировку смотрит он, а не личный.
      if (sql.includes('employee_department_access')) return [head(999, 'D3')];
      return [];
    });
    schedMock.mockResolvedValue(buildSchedules([{ emp: 3, date: WEEKDAY, weekend: false }]));
    directMgrsMock.mockResolvedValue(new Map([[3, { managerId: 300, managerFullName: 'M' }]]));

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 33, employee_id: 3, work_date: WEEKDAY, org_department_id: 'D3' },
    ]);
    expect(res.get(33)).toEqual([999]);
  });

  it('будний день: у отдела нет руководителя → «Человек»', async () => {
    pgQuery.mockImplementation(async () => []);
    schedMock.mockResolvedValue(buildSchedules([{ emp: 3, date: WEEKDAY, weekend: false }]));
    directMgrsMock.mockResolvedValue(new Map([[3, { managerId: 300, managerFullName: 'M' }]]));

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 34, employee_id: 3, work_date: WEEKDAY, org_department_id: 'D3' },
    ]);
    expect(res.get(34)).toEqual([300]);
  });

  it('руководитель отдела не согласует сам себя: остаётся второй руководитель', async () => {
    pgQuery.mockImplementation(async (sql: string) =>
      sql.includes('employee_department_access') ? [head(400, 'D4'), head(401, 'D4')] : []);
    schedMock.mockResolvedValue(buildSchedules([{ emp: 400, date: WEEKDAY, weekend: false }]));
    directMgrsMock.mockResolvedValue(new Map());

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 45, employee_id: 400, work_date: WEEKDAY, org_department_id: 'D4' },
    ]);
    expect(res.get(45)).toEqual([401]);
  });

  it('единственный руководитель отдела = автор строки → падаем на «Человека»', async () => {
    pgQuery.mockImplementation(async (sql: string) =>
      sql.includes('employee_department_access') ? [head(400, 'D4')] : []);
    schedMock.mockResolvedValue(buildSchedules([{ emp: 400, date: WEEKDAY, weekend: false }]));
    directMgrsMock.mockResolvedValue(new Map([[400, { managerId: 300, managerFullName: 'M' }]]));

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 46, employee_id: 400, work_date: WEEKDAY, org_department_id: 'D4' },
    ]);
    expect(res.get(46)).toEqual([300]);
  });

  it('будний день без «Человека» → начальники отдела (full), их может быть несколько', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('employee_department_access')) return [head(400, 'D4'), head(401, 'D4')];
      return [];
    });
    schedMock.mockResolvedValue(buildSchedules([{ emp: 4, date: WEEKDAY, weekend: false }]));
    directMgrsMock.mockResolvedValue(new Map());

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 44, employee_id: 4, work_date: WEEKDAY, org_department_id: 'D4' },
    ]);
    expect(res.get(44)).toEqual([400, 401]);
  });

  it('будний день без «Человека» и без начальников → пусто', async () => {
    pgQuery.mockImplementation(async () => []);
    schedMock.mockResolvedValue(buildSchedules([{ emp: 5, date: WEEKDAY, weekend: false }]));
    directMgrsMock.mockResolvedValue(new Map());

    const res = await resolveResponsibleEmployeeIdsForRows([
      { id: 55, employee_id: 5, work_date: WEEKDAY, org_department_id: 'D5' },
    ]);
    expect(res.get(55)).toEqual([]);
  });
});

describe('resolveResponsibleEmployeeIdsByEmployee (заявления, без даты)', () => {
  it('есть начальник отдела → он, «Человек» игнорируется', async () => {
    pgQuery.mockImplementation(async (sql: string) =>
      sql.includes('employee_department_access') ? [head(999, 'D1')] : [],
    );
    directMgrsMock.mockResolvedValue(new Map([[1, { managerId: 300, managerFullName: 'M' }]]));

    const res = await resolveResponsibleEmployeeIdsByEmployee([{ employee_id: 1, org_department_id: 'D1' }]);
    expect(res.get(1)).toEqual([999]);
  });

  it('нет начальника отдела → непосредственный руководитель', async () => {
    pgQuery.mockImplementation(async () => []);
    directMgrsMock.mockResolvedValue(new Map([[1, { managerId: 300, managerFullName: 'M' }]]));

    const res = await resolveResponsibleEmployeeIdsByEmployee([{ employee_id: 1, org_department_id: 'D1' }]);
    expect(res.get(1)).toEqual([300]);
  });

  it('нет руководителя → начальники отдела (full), их может быть несколько', async () => {
    pgQuery.mockImplementation(async (sql: string) =>
      sql.includes('employee_department_access') ? [head(400, 'D4'), head(401, 'D4')] : [],
    );
    directMgrsMock.mockResolvedValue(new Map());

    const res = await resolveResponsibleEmployeeIdsByEmployee([{ employee_id: 4, org_department_id: 'D4' }]);
    expect(res.get(4)).toEqual([400, 401]);
  });

  it('нет ни руководителя, ни начальников → пусто', async () => {
    pgQuery.mockImplementation(async () => []);
    directMgrsMock.mockResolvedValue(new Map());

    const res = await resolveResponsibleEmployeeIdsByEmployee([{ employee_id: 5, org_department_id: 'D5' }]);
    expect(res.get(5)).toEqual([]);
  });
});
