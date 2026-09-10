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

/** Карточка сотрудника: активный без увольнения, если тест не сказал иначе. */
const activeRow = {
  employment_status: 'active',
  dismissal_date: null,
  excluded_from_timesheet_date: null,
};

/**
 * exec транзакции: назначения отдаёт резолвер владения (бр.Каримов до 24.08,
 * дальше другой отдел), остальные запросы сборщика — пустые/справочные.
 */
function makeClient(employeeRow: Record<string, unknown> = activeRow) {
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
      if (sql.includes('tab_number')) return { rows: [{ id: EMPLOYEE, tab_number: '05123', ...employeeRow }] };
      return { rows: [] };
    }),
  };
}


/**
 * exec без истории назначений: владение днём остаётся снимочным, поэтому единственный
 * фильтр в этих тестах — отсечка по увольнению.
 */
function makeClientNoHistory(employeeRow: Record<string, unknown>) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM org_departments')) return { rows: [{ name: 'бр.Каримов О.М.' }] };
      if (sql.includes('tab_number')) return { rows: [{ id: EMPLOYEE, tab_number: '05123', ...employeeRow }] };
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
      if (sql.includes('tab_number')) return { rows: [{ id: EMPLOYEE, tab_number: '05123', ...activeRow }] };
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

/**
 * Пустые дни ПОСЛЕ увольнения не должны попадать в редакцию: 1С видела их как
 * «сотрудник не оформлен в ЗУП». Режем только неявку с нулём часов — реально
 * отработанное после даты увольнения обязано доехать до 1С, иначе часы уволенного
 * задним числом молча пропадут из неизменяемой редакции.
 */
describe('buildTimesheetPayload — пустые дни после увольнения', () => {
  const fired = (dismissal: string | null, excluded: string | null = null) => ({
    employment_status: 'fired',
    dismissal_date: dismissal,
    excluded_from_timesheet_date: excluded,
  });

  const absent = () => ({ status: 'absent', hours: 0, corrected: false, hoursOverridden: false });
  const zeroed = () => ({ status: 'manual', hours: 0, corrected: true, hoursOverridden: true });

  const bulk = (dataMap: Map<number, Map<string, ReturnType<typeof day>>>, extra: {
    entries?: Array<{ employee_id: number; work_date: string }>;
    objectEntries?: Array<{ employee_id: number; work_date: string; object_id?: string | null }>;
  } = {}) => ({
    employees: [{ id: EMPLOYEE, full_name: 'Ибрагимов А. М.', sigur_employee_id: 100751, position_id: null }],
    posMap: new Map(),
    entries: extra.entries ?? [],
    objectEntries: extra.objectEntries ?? [],
    dataMap,
  });

  it('неявка с нулём часов после увольнения выпадает, день увольнения остаётся', async () => {
    fetchBulk.mockResolvedValue(bulk(new Map([[EMPLOYEE, new Map([
      ['2026-08-20', day(11)],
      ['2026-08-25', absent()],
      ['2026-08-26', absent()],
      ['2026-08-27', absent()],
      ['2026-08-31', absent()],
    ])]])));

    const { payload } = await buildTimesheetPayload(
      makeClientNoHistory(fired('2026-08-25')) as never, approval as never,
    );
    const employee = payload.employees[0]!;

    expect(Object.keys(employee.days)).toEqual(['2026-08-20', '2026-08-25']);
    expect(employee.total_hours).toBe(11);
  });

  it('отработанные дни после увольнения СОХРАНЯЮТСЯ (уволен задним числом)', async () => {
    fetchBulk.mockResolvedValue(bulk(
      new Map([[EMPLOYEE, new Map([
        ['2026-08-26', day(11.27)],
        ['2026-08-27', absent()],
        ['2026-08-28', zeroed()],
        ['2026-08-31', day(11.8)],
      ])]]),
      // Проходы СКУД после даты увольнения — именно они и делают день реальным.
      { entries: [{ employee_id: EMPLOYEE, work_date: '2026-08-26' }] },
    ));

    const { payload } = await buildTimesheetPayload(
      makeClientNoHistory(fired('2026-08-25')) as never, approval as never,
    );
    const employee = payload.employees[0]!;

    // Пустая неявка ушла; часы и осознанно обнулённый день (manual) остались.
    expect(Object.keys(employee.days)).toEqual(['2026-08-26', '2026-08-28', '2026-08-31']);
    expect(employee.total_hours).toBe(23.07);
    expect(employee.zero_activity).toBe(false);
  });

  it('отложенное увольнение действующего сотрудника ничего не режет', async () => {
    fetchBulk.mockResolvedValue(bulk(new Map([[EMPLOYEE, new Map([
      ['2026-08-20', day(11)],
      ['2026-08-26', absent()],
      ['2026-08-31', absent()],
    ])]])));

    // Дата увольнения проставлена заранее, перевод в fired ещё не применён.
    const { payload } = await buildTimesheetPayload(
      makeClientNoHistory({ ...activeRow, dismissal_date: '2026-08-25' }) as never, approval as never,
    );

    expect(Object.keys(payload.employees[0]!.days)).toEqual(['2026-08-20', '2026-08-26', '2026-08-31']);
  });

  it('excluded_from_timesheet_date раньше dismissal+1 — граница по ней', async () => {
    fetchBulk.mockResolvedValue(bulk(new Map([[EMPLOYEE, new Map([
      ['2026-08-18', absent()],
      ['2026-08-20', absent()],
      ['2026-08-25', absent()],
    ])]])));

    const { payload } = await buildTimesheetPayload(
      makeClientNoHistory(fired('2026-08-25', '2026-08-20')) as never, approval as never,
    );

    // 18.08 — до границы: неявка легитимна (прогул при живом трудоустройстве).
    expect(Object.keys(payload.employees[0]!.days)).toEqual(['2026-08-18']);
  });

  it('после увольнения только пустые дни: days пуст, zero_activity true, состав сохранён', async () => {
    fetchBulk.mockResolvedValue(bulk(
      new Map([[EMPLOYEE, new Map([['2026-08-26', absent()], ['2026-08-31', absent()]])]]),
    ));

    const { payload } = await buildTimesheetPayload(
      makeClientNoHistory(fired('2026-08-25')) as never, approval as never,
    );
    const employee = payload.employees[0]!;

    expect(employee.days).toEqual({});
    expect(employee.total_hours).toBe(0);
    expect(employee.zero_activity).toBe(true);
    // Уволенный остаётся строкой выгрузки — как в Excel: состав подачи не меняется.
    expect(payload.employees).toHaveLength(1);
    expect(payload.employees_count).toBe(1);
  });

  it('объектная разбивка идёт по оставшимся дням: пустого дня в ней нет, рабочий есть', async () => {
    fetchBulk.mockResolvedValue(bulk(
      new Map([[EMPLOYEE, new Map([['2026-08-26', absent()], ['2026-08-27', day(9)]])]]),
      {
        objectEntries: [
          { employee_id: EMPLOYEE, work_date: '2026-08-26', object_id: null },
          { employee_id: EMPLOYEE, work_date: '2026-08-27', object_id: null },
        ],
      },
    ));

    const { objects } = await buildTimesheetPayload(
      makeClientNoHistory(fired('2026-08-25')) as never, approval as never,
    );
    const serialized = JSON.stringify(objects.payload);

    expect(serialized).not.toContain('2026-08-26');
    expect(serialized).toContain('2026-08-27');
  });
});
