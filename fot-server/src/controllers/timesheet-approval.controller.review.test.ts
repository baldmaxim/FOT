import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

// Регрессия: чужие корректировки вне окна членства сотрудника в отделе
// не должны влиять на согласование табеля (getReviewList) и серверный
// precheck утверждения (approve). См. кейс Шамхаловой (перевод 05.06).

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({ pgQuery: vi.fn(), pgQueryOne: vi.fn() }));
vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: pgQueryOne,
}));

const { resolveScopeMock, resolveScopedDeptMock } = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(async () => 'all'),
  // approve() теперь проверяет ensureApprovalAccess (→ resolveScopedDepartmentId) ДО
  // precheck pending-корректировок — эти тесты бьют по admin-сценарию (scope='all'),
  // поэтому доступ к запрошенному отделу всегда есть.
  resolveScopedDeptMock: vi.fn(async (_req: unknown, deptId: string | null) => deptId),
}));
vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveRequestDataScope: resolveScopeMock,
  resolveScopedDepartmentId: resolveScopedDeptMock,
}));

const { checkWeekendMock } = vi.hoisted(() => ({ checkWeekendMock: vi.fn() }));
vi.mock('../services/timesheet-approval-weekend-check.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-approval-weekend-check.service.js')>()),
  checkWeekendWorkRequirement: checkWeekendMock,
}));

// Окно членства мокаем, остальные экспорты (buildMembershipWindowMap /
// isWithinMembershipWindow) — реальные: именно их корректность проверяем.
const { listMembershipsMock } = vi.hoisted(() => ({ listMembershipsMock: vi.fn() }));
vi.mock('../services/timesheet-department-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-department-assignments.service.js')>()),
  listEmployeeMembershipsForDepartmentPeriod: listMembershipsMock,
}));

import { timesheetApprovalController } from './timesheet-approval.controller.js';

const DEPT = '3ad4aa9f-d988-4c49-bc52-abb74ef74bd9'; // УОК
const SHAMHALOVA = 2096; // переведена из УОК 05.06
const GAEV = 420; // действующий сотрудник УОК

const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() } as Record<string, ReturnType<typeof vi.fn>>;
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveScopeMock.mockResolvedValue('all');
});

describe('getReviewList — pending/approved выходные по окну членства', () => {
  it('чужой выход переведённого (вне окна) не попадает в pending_weekend_dates; in-window — попадает', async () => {
    const approval = {
      id: 521, department_id: DEPT, manager_employee_id: null,
      start_date: '2026-06-01', end_date: '2026-06-15', status: 'submitted',
      submitted_by: 'u1', reviewed_by: null, updated_at: '2026-06-16T00:00:00Z',
    };
    // 12.06 (выход Шамхаловой, вне окна) и 13.06 (выход действующего члена).
    checkWeekendMock.mockResolvedValue({
      requires: true,
      weekendDates: ['2026-06-12', '2026-06-13'],
      weekendWorkDates: ['2026-06-12', '2026-06-13'],
      weekendWorkPairs: [],
    });
    listMembershipsMock.mockResolvedValue([
      { employee_id: SHAMHALOVA, transferred_out_date: '2026-06-05', joined_date: null, joined_via_transfer: false },
      { employee_id: GAEV, transferred_out_date: null, joined_date: null, joined_via_transfer: false },
    ]);

    pgQuery.mockImplementation(async (sql: string) => {
      if (/FROM timesheet_approvals/i.test(sql)) return [approval];
      if (/FROM org_departments/i.test(sql)) return [{ id: DEPT, name: 'УОК' }];
      if (/FROM user_profiles/i.test(sql)) return [];
      if (/FROM timesheet_timekeeper_review/i.test(sql)) return [];
      if (/FROM attendance_adjustments/i.test(sql)) {
        return [
          // Шамхалова: 12.06 pending — вне окна (переведена 05.06).
          { employee_id: SHAMHALOVA, work_date: '2026-06-12', status: 'work', hours_override: null, source_type: 'leave_request', created_by: null, approval_status: 'pending' },
          // Действующий член: 13.06 pending — в окне.
          { employee_id: GAEV, work_date: '2026-06-13', status: 'work', hours_override: null, source_type: 'leave_request', created_by: null, approval_status: 'pending' },
        ];
      }
      return [];
    });

    const req = { query: { status: 'submitted' }, user: { id: 'admin' } } as unknown as AuthenticatedRequest;
    const res = makeRes();
    await timesheetApprovalController.getReviewList(req, res as never);

    expect(res.json).toHaveBeenCalledTimes(1);
    const data = res.json.mock.calls[0][0].data;
    expect(data).toHaveLength(1);
    // 12.06 Шамхаловой отфильтрован; 13.06 действующего члена остался.
    expect(data[0].pending_weekend_dates).toEqual(['2026-06-13']);
    // weekend_work_dates не трогаем — обе даты на месте.
    expect(data[0].weekend_work_dates).toEqual(['2026-06-12', '2026-06-13']);
  });
});

describe('approve precheck — pending по окну членства', () => {
  const baseReq = { params: { id: '521' }, body: {}, user: { id: 'admin', employee_id: 1 } } as unknown as AuthenticatedRequest;

  it('только out-of-window pending → НЕ возвращает PENDING_CORRECTIONS_EXIST', async () => {
    // status='approved' → changeApprovalReviewState вернёт 400 (не на проверке),
    // что доказывает: precheck пройден (409 не выставлен).
    pgQueryOne.mockResolvedValue({
      id: 521, department_id: DEPT, manager_employee_id: null,
      start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved',
    });
    listMembershipsMock.mockResolvedValue([
      { employee_id: SHAMHALOVA, transferred_out_date: '2026-06-05', joined_date: null, joined_via_transfer: false },
    ]);
    pgQuery.mockImplementation(async (sql: string) =>
      /FROM attendance_adjustments/i.test(sql)
        ? [{ employee_id: SHAMHALOVA, work_date: '2026-06-12' }] // вне окна
        : []);

    const res = makeRes();
    await timesheetApprovalController.approve(baseReq, res as never);

    const codes = res.json.mock.calls.map((c) => c[0]?.code);
    expect(codes).not.toContain('PENDING_CORRECTIONS_EXIST');
    expect(res.status).toHaveBeenCalledWith(400); // дошёл до проверки статуса
  });

  it('in-window pending → 409 PENDING_CORRECTIONS_EXIST', async () => {
    pgQueryOne.mockResolvedValue({
      id: 521, department_id: DEPT, manager_employee_id: null,
      start_date: '2026-06-01', end_date: '2026-06-15', status: 'submitted',
    });
    listMembershipsMock.mockResolvedValue([
      { employee_id: GAEV, transferred_out_date: null, joined_date: null, joined_via_transfer: false },
    ]);
    pgQuery.mockImplementation(async (sql: string) =>
      /FROM attendance_adjustments/i.test(sql)
        ? [{ employee_id: GAEV, work_date: '2026-06-13' }] // в окне
        : []);

    const res = makeRes();
    await timesheetApprovalController.approve(baseReq, res as never);

    expect(res.status).toHaveBeenCalledWith(409);
    const payload = res.json.mock.calls[0][0];
    expect(payload.code).toBe('PENDING_CORRECTIONS_EXIST');
    expect(payload.pending_count).toBe(1);
  });
});
