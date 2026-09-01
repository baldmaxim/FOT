import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Версия табеля обязана содержать только те дни, которыми подача владеет.
 *
 * Иначе переведённый в середине периода уносит дни новой бригады в выгрузку старой,
 * и одна пара (сотрудник, дата) попадает в две версии для 1С — двойной счёт часов.
 * Проверяем не только days, но и производные: total_hours и zero_activity.
 */

const {
  fetchBulk, hasRealActivity, listApprovalEmployees, listMemberships, listSupervisors,
} = vi.hoisted(() => ({
  fetchBulk: vi.fn(),
  hasRealActivity: vi.fn(),
  listApprovalEmployees: vi.fn(),
  listMemberships: vi.fn(),
  listSupervisors: vi.fn(),
}));

vi.mock('./timesheet-export.service.js', () => ({ fetchTimesheetDataForEmployees: fetchBulk }));
vi.mock('./attendance.service.js', () => ({ hasRealActivity }));
vi.mock('./timesheet-approval-employees-snapshot.service.js', () => ({ listApprovalEmployees }));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeMembershipsForDepartmentPeriod: listMemberships,
}));
vi.mock('../controllers/timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: listSupervisors,
}));

import { buildTimesheetPayload } from './timesheet-version.service.js';

const OLD_APPROVAL = 1551;
const DEPT_OLD = 'e443116c-62f3-4b08-870f-4f7e9f52c662';
const EMPLOYEE = 661;
const TRANSFER_DAY = '2026-08-25';

const approval = {
  id: OLD_APPROVAL,
  department_id: DEPT_OLD,
  manager_employee_id: null,
  start_date: '2026-08-16',
  end_date: '2026-08-31',
  status: 'approved',
};

/**
 * exec транзакции: назначения отдаёт резолвер владения (бр.Каримов до 24.08,
 * дальше другой отдел), остальные запросы сборщика — пустые/справочные.
 */
function makeClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM employee_assignments ea')) {
        return {
          rows: [
            {
              employee_id: EMPLOYEE,
              effective_from: '2026-07-30',
              effective_to: '2026-08-24',
              owning_approval_ids: [OLD_APPROVAL],
            },
            {
              employee_id: EMPLOYEE,
              effective_from: TRANSFER_DAY,
              effective_to: null,
              owning_approval_ids: [],
            },
          ],
        };
      }
      if (sql.includes('FROM org_departments')) return { rows: [{ name: 'бр.Каримов О.М.' }] };
      if (sql.includes('tab_number')) return { rows: [{ id: EMPLOYEE, tab_number: '05123' }] };
      return { rows: [] };
    }),
  };
}

const day = (hours: number) => ({ status: 'work', hours, corrected: false, hoursOverridden: false });

beforeEach(() => {
  vi.clearAllMocks();
  listApprovalEmployees.mockResolvedValue([{ employee_id: EMPLOYEE, full_name: 'Ибрагимов А. М.' }]);
  listMemberships.mockResolvedValue([]);
  listSupervisors.mockResolvedValue(new Set<number>());
  hasRealActivity.mockReturnValue(true);
});

describe('buildTimesheetPayload — владение днём', () => {
  it('оставляет только дни до перевода и пересчитывает total_hours', async () => {
    fetchBulk.mockResolvedValue({
      employees: [{ id: EMPLOYEE, full_name: 'Ибрагимов А. М.', sigur_employee_id: 100751, position_id: null }],
      posMap: new Map(),
      entries: [],
      objectEntries: [],
      dataMap: new Map([[EMPLOYEE, new Map([
        ['2026-08-20', day(11)],
        ['2026-08-24', day(10)],
        [TRANSFER_DAY, day(11.81)],
        ['2026-08-30', day(9)],
      ])]]),
    });

    const { payload } = await buildTimesheetPayload(makeClient() as never, approval as never);
    const employee = payload.employees[0]!;

    expect(Object.keys(employee.days)).toEqual(['2026-08-20', '2026-08-24']);
    expect(employee.total_hours).toBe(21);
    expect(payload.total_hours).toBe(21);
  });

  it('активность только после перевода: дней нет, total 0, zero_activity true', async () => {
    fetchBulk.mockResolvedValue({
      employees: [{ id: EMPLOYEE, full_name: 'Ибрагимов А. М.', sigur_employee_id: 100751, position_id: null }],
      posMap: new Map(),
      entries: [{ employee_id: EMPLOYEE, work_date: '2026-08-30' }],
      objectEntries: [{ employee_id: EMPLOYEE, work_date: '2026-08-29' }],
      dataMap: new Map([[EMPLOYEE, new Map([[TRANSFER_DAY, day(11.81)], ['2026-08-30', day(9)]])]]),
    });

    const { payload } = await buildTimesheetPayload(makeClient() as never, approval as never);
    const employee = payload.employees[0]!;

    expect(employee.days).toEqual({});
    expect(employee.total_hours).toBe(0);
    expect(employee.zero_activity).toBe(true);
  });

  it('без истории назначений дни остаются за подачей (снимочное владение)', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM org_departments')) return { rows: [{ name: 'бр.Каримов О.М.' }] };
      if (sql.includes('tab_number')) return { rows: [{ id: EMPLOYEE, tab_number: '05123' }] };
      return { rows: [] };
    }) };

    fetchBulk.mockResolvedValue({
      employees: [{ id: EMPLOYEE, full_name: 'Ибрагимов А. М.', sigur_employee_id: 100751, position_id: null }],
      posMap: new Map(),
      entries: [{ employee_id: EMPLOYEE, work_date: '2026-08-30' }],
      objectEntries: [],
      dataMap: new Map([[EMPLOYEE, new Map([['2026-08-20', day(11)], ['2026-08-30', day(9)]])]]),
    });

    const { payload } = await buildTimesheetPayload(client as never, approval as never);
    const employee = payload.employees[0]!;

    expect(Object.keys(employee.days)).toEqual(['2026-08-20', '2026-08-30']);
    expect(employee.total_hours).toBe(20);
    expect(employee.zero_activity).toBe(false);
  });
});
