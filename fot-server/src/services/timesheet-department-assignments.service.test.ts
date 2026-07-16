import { describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const { collectDeptIdsMock } = vi.hoisted(() => ({ collectDeptIdsMock: vi.fn() }));
vi.mock('./skud-shared.service.js', () => ({ collectDeptIds: collectDeptIdsMock }));

import {
  formatDateShift,
  isAssignmentActiveOnDateInclusive,
  isEmployeeAssignedToDepartmentOnDate,
  listEmployeeMembershipsForDepartmentPeriod,
  listScopedMembersByDepartment,
  resolveTimesheetPeriodRange,
  buildMembershipWindowMap,
  isWithinMembershipWindow,
} from './timesheet-department-assignments.service.js';

describe('timesheet-department-assignments.service', () => {
  it('resolves FULL, H1 and H2 ranges for a month', () => {
    expect(resolveTimesheetPeriodRange('2026-02', 'FULL')).toEqual({
      half: 'FULL',
      year: 2026,
      month: 2,
      daysInMonth: 28,
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    expect(resolveTimesheetPeriodRange('2026-02', 'H1')).toEqual({
      half: 'H1',
      year: 2026,
      month: 2,
      daysInMonth: 28,
      startDate: '2026-02-01',
      endDate: '2026-02-15',
    });
    expect(resolveTimesheetPeriodRange('2026-02', 'H2')).toEqual({
      half: 'H2',
      year: 2026,
      month: 2,
      daysInMonth: 28,
      startDate: '2026-02-16',
      endDate: '2026-02-28',
    });
  });

  it('treats effective_to as inclusive for historical department access', () => {
    expect(isAssignmentActiveOnDateInclusive('2026-04-01', '2026-04-15', '2026-04-15')).toBe(true);
    expect(isAssignmentActiveOnDateInclusive('2026-04-01', '2026-04-15', '2026-04-16')).toBe(false);
    expect(isAssignmentActiveOnDateInclusive('2026-04-16', null, '2026-04-16')).toBe(true);
  });

  it('shifts dates across month boundaries', () => {
    expect(formatDateShift('2026-04-01', -1)).toBe('2026-03-31');
    expect(formatDateShift('2026-04-30', 1)).toBe('2026-05-01');
  });

  describe('isEmployeeAssignedToDepartmentOnDate — уволенный с затёртым отделом', () => {
    const BRIGADE = 'b9a752a5-4565-4b27-87a7-5cd6db81d0a9';
    const FIRED = 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'; // «Уволенные»

    it('даёт доступ через employee_dismissal_events, когда assignment/snapshot указывают на «Уволенные»', async () => {
      collectDeptIdsMock.mockResolvedValue([BRIGADE]);
      pgQueryOne
        .mockResolvedValueOnce(null) // employee_assignments — нет открытого назначения в бригаду
        .mockResolvedValueOnce({ org_department_id: FIRED }) // snapshot → «Уволенные», не совпадает
        .mockResolvedValueOnce({ exists: true }); // dismissal_events.from_department_id = бригада

      await expect(isEmployeeAssignedToDepartmentOnDate(8730, BRIGADE, '2026-05-21')).resolves.toBe(true);
    });

    it('отказывает, если dismissal-события для бригады нет', async () => {
      collectDeptIdsMock.mockResolvedValue([BRIGADE]);
      pgQueryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ org_department_id: FIRED })
        .mockResolvedValueOnce(null); // dismissal events не нашлись (например дата > dismissal_date)

      await expect(isEmployeeAssignedToDepartmentOnDate(8730, BRIGADE, '2026-06-01')).resolves.toBe(false);
    });
  });

  describe('buildMembershipWindowMap / isWithinMembershipWindow — окно членства', () => {
    it('строит карту окон из memberships', () => {
      const map = buildMembershipWindowMap([
        { employee_id: 2096, transferred_out_date: '2026-06-05', joined_date: null, joined_via_transfer: false },
        { employee_id: 420, transferred_out_date: null, joined_date: '2026-06-05', joined_via_transfer: true },
      ]);
      expect(map.get(2096)).toEqual({ joined: null, transferredOut: '2026-06-05', joinedViaTransfer: false });
      expect(map.get(420)).toEqual({ joined: '2026-06-05', transferredOut: null, joinedViaTransfer: true });
    });

    it('нет окна (подача «по людям») → всегда true', () => {
      expect(isWithinMembershipWindow(undefined, '2026-06-12')).toBe(true);
    });

    it('верхняя граница: дата >= transferredOut → false (искл.), раньше → true', () => {
      const w = { joined: null, transferredOut: '2026-06-05', joinedViaTransfer: false };
      // Кейс Шамхаловой: переведена 05.06, праздничный выход 12.06 — вне окна УОК.
      expect(isWithinMembershipWindow(w, '2026-06-12', 'viaTransferOnly')).toBe(false);
      expect(isWithinMembershipWindow(w, '2026-06-05', 'viaTransferOnly')).toBe(false);
      expect(isWithinMembershipWindow(w, '2026-06-04', 'viaTransferOnly')).toBe(true);
    });

    it('нижняя граница по режимам', () => {
      const wReal = { joined: '2026-06-05', transferredOut: null, joinedViaTransfer: true };
      const wDirty = { joined: '2026-06-05', transferredOut: null, joinedViaTransfer: false };
      // always — режет всегда
      expect(isWithinMembershipWindow(wDirty, '2026-06-01', 'always')).toBe(false);
      // viaTransferOnly — режет только при настоящем переводе
      expect(isWithinMembershipWindow(wReal, '2026-06-01', 'viaTransferOnly')).toBe(false);
      expect(isWithinMembershipWindow(wDirty, '2026-06-01', 'viaTransferOnly')).toBe(true);
      // never — нижнюю границу не применяем
      expect(isWithinMembershipWindow(wReal, '2026-06-01', 'never')).toBe(true);
      // в окне (>= joined) — всегда true
      expect(isWithinMembershipWindow(wReal, '2026-06-05', 'viaTransferOnly')).toBe(true);
    });
  });

  describe('listEmployeeMembershipsForDepartmentPeriod — snapshot с учётом периода', () => {
    const DEPT = 'cac1f75d-f565-469f-ad40-b498ca5211aa'; // новый отдел (Макшанов)

    it('вход в отдел ПОСЛЕ периода (пара prev→cur) → не член за прошлый месяц (не тянем по snapshot)', async () => {
      pgQuery.mockReset();
      collectDeptIdsMock.mockResolvedValue([DEPT]);
      pgQuery
        .mockResolvedValueOnce([])                     // assignments ∩ период — новое назначение (01.07) не пересекает июнь
        .mockResolvedValueOnce([])                     // firedFromDept
        .mockResolvedValueOnce([{ employee_id: 2495 }])// transferredInAfter — настоящий вход после периода
        .mockResolvedValueOnce([{ id: 2495 }]);        // snapshotEmployees — snapshot уже указывает на новый отдел

      const res = await listEmployeeMembershipsForDepartmentPeriod(DEPT, '2026-06-01', '2026-06-30');

      expect(res).toEqual([]); // ранний выход: map пуст, activeRows/transferJoins не запрашиваются
      expect(pgQuery).toHaveBeenCalledTimes(4);
      // guard-запрос получает [deptIds, endDate]
      expect(pgQuery.mock.calls[2][1]).toEqual([[DEPT], '2026-06-30']);
    });

    it('смена должности того же отдела (нет prev-стыка) → остаётся членом за прошлый месяц', async () => {
      pgQuery.mockReset();
      collectDeptIdsMock.mockResolvedValue([DEPT]);
      pgQuery
        .mockResolvedValueOnce([])                     // assignments ∩ период
        .mockResolvedValueOnce([])                     // firedFromDept
        .mockResolvedValueOnce([])                     // transferredInAfter — пары нет (смена должности)
        .mockResolvedValueOnce([{ id: 500 }])          // snapshotEmployees
        .mockResolvedValueOnce([])                     // transferJoins
        .mockResolvedValueOnce([{ id: 500, excluded_from_timesheet: false, excluded_from_timesheet_date: null }]); // activeRows

      const res = await listEmployeeMembershipsForDepartmentPeriod(DEPT, '2026-06-01', '2026-06-30');

      expect(res).toEqual([
        { employee_id: 500, transferred_out_date: null, joined_date: null, joined_via_transfer: false },
      ]);
    });

    it('«выход-возврат»: source-A transferred_out_date НЕ обнуляется snapshot-веткой', async () => {
      pgQuery.mockReset();
      collectDeptIdsMock.mockResolvedValue([DEPT]);
      pgQuery
        // был в отделе до 30.06 (source A даёт transferred_out_date = 01.07)
        .mockResolvedValueOnce([{ employee_id: 600, effective_from: '2026-05-01', effective_to: '2026-06-30', org_department_id: DEPT }])
        .mockResolvedValueOnce([])                     // firedFromDept
        .mockResolvedValueOnce([{ employee_id: 600 }])// transferredInAfter — вернулся после периода
        .mockResolvedValueOnce([{ id: 600 }])          // snapshotEmployees — snapshot снова на этот отдел
        .mockResolvedValueOnce([])                     // transferJoins
        .mockResolvedValueOnce([{ id: 600, excluded_from_timesheet: false, excluded_from_timesheet_date: null }]); // activeRows

      const res = await listEmployeeMembershipsForDepartmentPeriod(DEPT, '2026-06-01', '2026-06-30');

      expect(res).toEqual([
        { employee_id: 600, transferred_out_date: '2026-07-01', joined_date: '2026-05-01', joined_via_transfer: false },
      ]);
    });

    it('snapshot-only без назначений → член (без регрессии)', async () => {
      pgQuery.mockReset();
      collectDeptIdsMock.mockResolvedValue([DEPT]);
      pgQuery
        .mockResolvedValueOnce([])                     // assignments
        .mockResolvedValueOnce([])                     // firedFromDept
        .mockResolvedValueOnce([])                     // transferredInAfter
        .mockResolvedValueOnce([{ id: 700 }])          // snapshotEmployees
        .mockResolvedValueOnce([])                     // transferJoins
        .mockResolvedValueOnce([{ id: 700, excluded_from_timesheet: false, excluded_from_timesheet_date: null }]); // activeRows

      const res = await listEmployeeMembershipsForDepartmentPeriod(DEPT, '2026-06-01', '2026-06-30');

      expect(res).toEqual([
        { employee_id: 700, transferred_out_date: null, joined_date: null, joined_via_transfer: false },
      ]);
    });
  });

  describe('listScopedMembersByDepartment — bulk-членство', () => {
    it('пустой scope → пустая карта, без обращения к БД', async () => {
      pgQuery.mockClear();
      const res = await listScopedMembersByDepartment([], '2026-05-01', '2026-05-31');
      expect(res.size).toBe(0);
      expect(pgQuery).not.toHaveBeenCalled();
    });

    it('строит карту employee_id → один отдел и передаёт параметры [scope, start, end]', async () => {
      pgQuery.mockClear();
      pgQuery.mockResolvedValueOnce([
        { employee_id: 10, dept_id: 'd1' },
        { employee_id: 11, dept_id: 'd1' },
        { employee_id: 12, dept_id: 'd2' },
      ]);
      const res = await listScopedMembersByDepartment(['d1', 'd2'], '2026-05-01', '2026-05-31');
      expect(pgQuery).toHaveBeenCalledTimes(1);
      expect(pgQuery.mock.calls[0][1]).toEqual([['d1', 'd2'], '2026-05-01', '2026-05-31']);
      expect([...res.entries()]).toEqual([[10, 'd1'], [11, 'd1'], [12, 'd2']]);
    });
  });
});
