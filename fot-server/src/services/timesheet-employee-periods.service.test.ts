import { describe, expect, it } from 'vitest';
import { buildEmployeeDepartmentPeriods, type IEmployeePeriodsMeta } from './timesheet-employee-periods.service.js';
import type { IEmployeeDepartmentAssignment } from './timesheet-department-assignments.service.js';

const DEPT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const DEPT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const employee = (overrides: Partial<IEmployeePeriodsMeta> = {}): IEmployeePeriodsMeta => ({
  hire_date: '2020-01-01',
  org_department_id: DEPT_A,
  employment_status: 'active',
  dismissal_date: null,
  excluded_from_timesheet: false,
  excluded_from_timesheet_date: null,
  ...overrides,
});

const assignment = (
  id: string,
  departmentId: string | null,
  from: string,
  to: string | null,
  positionId: string | null = null,
): IEmployeeDepartmentAssignment => ({
  id,
  employee_id: 1,
  org_department_id: departmentId,
  position_id: positionId,
  effective_from: from,
  effective_to: to,
});

const build = (
  assignments: IEmployeeDepartmentAssignment[],
  meta: IEmployeePeriodsMeta = employee(),
  dismissalFromDepartmentId: string | null = null,
  startDate = '2026-08-01',
  endDate = '2026-08-31',
) => buildEmployeeDepartmentPeriods({
  assignments,
  employee: meta,
  dismissalFromDepartmentId,
  startDate,
  endDate,
});

describe('buildEmployeeDepartmentPeriods', () => {
  it('без переводов даёт один период на весь диапазон', () => {
    expect(build([assignment('a1', DEPT_A, '2020-01-01', null)])).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-31' },
    ]);
  });

  it('перевод внутри месяца даёт два непересекающихся периода', () => {
    const periods = build([
      assignment('a1', DEPT_A, '2020-01-01', '2026-08-14'),
      assignment('a2', DEPT_B, '2026-08-15', null),
    ]);

    expect(periods).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-14' },
      { org_department_id: DEPT_B, from: '2026-08-15', to: '2026-08-31' },
    ]);
  });

  it('смена только должности внутри отдела не создаёт новую строку', () => {
    const periods = build([
      assignment('a1', DEPT_A, '2020-01-01', '2026-08-09', 'pos-1'),
      assignment('a2', DEPT_A, '2026-08-10', null, 'pos-2'),
    ]);

    expect(periods).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-31' },
    ]);
  });

  it('A -> B -> A даёт три непересекающихся периода', () => {
    const periods = build([
      assignment('a1', DEPT_A, '2020-01-01', '2026-08-09'),
      assignment('a2', DEPT_B, '2026-08-10', '2026-08-19'),
      assignment('a3', DEPT_A, '2026-08-20', null),
    ]);

    expect(periods).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-09' },
      { org_department_id: DEPT_B, from: '2026-08-10', to: '2026-08-19' },
      { org_department_id: DEPT_A, from: '2026-08-20', to: '2026-08-31' },
    ]);
  });

  it('«грязный» одиночный effective_from не обрезает табель', () => {
    // Единственное назначение с поздним effective_from (артефакт freeze-синхронизации):
    // стыка с закрытым периодом другого отдела нет — период открывается с начала диапазона.
    const periods = build([assignment('a1', DEPT_A, '2026-08-20', null)]);

    expect(periods).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-31' },
    ]);
  });

  it('настоящий перевод обрезает нижнюю границу, в отличие от «грязной» даты', () => {
    const periods = build([
      assignment('a1', DEPT_B, '2020-01-01', '2026-08-19'),
      assignment('a2', DEPT_A, '2026-08-20', null),
    ]);

    expect(periods[1]).toEqual({ org_department_id: DEPT_A, from: '2026-08-20', to: '2026-08-31' });
  });

  it('увольнение обрезает период сверху', () => {
    const periods = build(
      [assignment('a1', DEPT_A, '2020-01-01', null)],
      employee({ employment_status: 'fired', dismissal_date: '2026-08-11' }),
    );

    expect(periods).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-11' },
    ]);
  });

  it('уволенный: реальный отдел берётся из dismissal-события', () => {
    const periods = build(
      [assignment('a1', DEPT_A, '2026-08-12', null)],
      employee({
        org_department_id: DEPT_A,
        employment_status: 'fired',
        dismissal_date: '2026-08-11',
      }),
      DEPT_B,
    );

    expect(periods).toContainEqual({ org_department_id: DEPT_B, from: '2026-08-01', to: '2026-08-11' });
  });

  it('дата приёма обрезает период снизу', () => {
    const periods = build(
      [assignment('a1', DEPT_A, '2020-01-01', null)],
      employee({ hire_date: '2026-08-17' }),
    );

    expect(periods).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-17', to: '2026-08-31' },
    ]);
  });

  it('исключение из табеля обрезает период предыдущим днём', () => {
    const periods = build(
      [assignment('a1', DEPT_A, '2020-01-01', null)],
      employee({ excluded_from_timesheet: true, excluded_from_timesheet_date: '2026-08-20' }),
    );

    expect(periods).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-19' },
    ]);
  });

  it('назначения без отдела пропускаются, работает snapshot-fallback', () => {
    expect(build([assignment('a1', null, '2020-01-01', null)])).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-31' },
    ]);
  });

  it('назначений нет вовсе — период из snapshot', () => {
    expect(build([])).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-01', to: '2026-08-31' },
    ]);
  });

  it('период целиком вне диапазона отбрасывается', () => {
    const periods = build([
      assignment('a1', DEPT_A, '2020-01-01', '2026-07-31'),
      assignment('a2', DEPT_B, '2026-08-01', null),
    ]);

    expect(periods).toEqual([
      { org_department_id: DEPT_B, from: '2026-08-01', to: '2026-08-31' },
    ]);
  });

  it('увольнение до начала диапазона не даёт периодов', () => {
    const periods = build(
      [assignment('a1', DEPT_A, '2020-01-01', null)],
      employee({ employment_status: 'fired', dismissal_date: '2026-07-20' }),
    );

    expect(periods).toEqual([]);
  });

  it('полумесяц: периоды обрезаются по запрошенному диапазону', () => {
    const periods = build(
      [
        assignment('a1', DEPT_A, '2020-01-01', '2026-08-20'),
        assignment('a2', DEPT_B, '2026-08-21', null),
      ],
      employee(),
      null,
      '2026-08-16',
      '2026-08-31',
    );

    expect(periods).toEqual([
      { org_department_id: DEPT_A, from: '2026-08-16', to: '2026-08-20' },
      { org_department_id: DEPT_B, from: '2026-08-21', to: '2026-08-31' },
    ]);
  });
});
