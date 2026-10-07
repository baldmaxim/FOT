import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

const { mockListMemberships } = vi.hoisted(() => ({ mockListMemberships: vi.fn() }));
vi.mock('./timesheet-department-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./timesheet-department-assignments.service.js')>()),
  listEmployeeMembershipsForDepartmentPeriod: mockListMemberships,
}));

const { mockVisibleSnapshot } = vi.hoisted(() => ({ mockVisibleSnapshot: vi.fn() }));
vi.mock('./timesheet-approval-employees-snapshot.service.js', () => ({
  listVisibleApprovalEmployees: mockVisibleSnapshot,
}));

const { mockRouteRows, mockLeaveApprovers } = vi.hoisted(() => ({
  mockRouteRows: vi.fn(),
  mockLeaveApprovers: vi.fn(),
}));
vi.mock('./approval-routing.service.js', () => ({
  resolveResponsibleEmployeeIdsForRows: mockRouteRows,
  resolveLeaveApproverEmployeeIdsByEmployee: mockLeaveApprovers,
}));

import {
  countPendingDecisionDays,
  countPendingDecisionsForApproval,
  describePendingDecisions,
  listPendingDecisionFacts,
  listPendingWorkRequestDays,
} from './timesheet-pending-decisions.service.js';

const RANGE = { startDate: '2026-09-01', endDate: '2026-09-15' };
const DEPT = { kind: 'department' as const, departmentId: 'dept-disp' };

type DayRow = { id: number; employee_id: number; work_date: string };
type RequestRow = { request_id: number; employee_id: number; work_date: string };

/** Ответы по тексту SQL: заявления 1-го этапа — первыми (в их SQL есть подзапрос к attendance_adjustments). */
function setupQueries(fx: { days?: DayRow[]; requests?: RequestRow[]; employees?: unknown[] }): void {
  pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM leave_requests')) return fx.requests ?? [];
    if (sql.includes('FROM attendance_adjustments')) return fx.days ?? [];
    if (sql.includes('FROM employees')) return fx.employees ?? [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockReset();
  mockListMemberships.mockReset();
});

describe('listPendingWorkRequestDays', () => {
  it('без сотрудников — без запроса', async () => {
    expect(await listPendingWorkRequestDays([], RANGE)).toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('только pending work без материализованных строк, даты обрезаны периодом', async () => {
    setupQueries({ requests: [{ request_id: 900, employee_id: 523, work_date: '2026-09-06' }] });

    const days = await listPendingWorkRequestDays([523, 523, 0], RANGE);

    expect(days).toEqual([{ request_id: 900, employee_id: 523, work_date: '2026-09-06' }]);
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lr.request_type = 'work'");
    expect(sql).toContain("lr.status = 'pending'");
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('GREATEST(lr.start_date, $2::date)');
    expect(params).toEqual([[523], RANGE.startDate, RANGE.endDate]);
  });
});

describe('listPendingDecisionFacts', () => {
  it('«по людям»: оба вида без окна членства', async () => {
    setupQueries({
      days: [{ id: 77, employee_id: 523, work_date: '2026-09-06' }],
      requests: [{ request_id: 900, employee_id: 1600, work_date: '2026-09-13' }],
    });

    const facts = await listPendingDecisionFacts({ kind: 'personal', employeeIds: [523, 1600] }, RANGE);

    expect(mockListMemberships).not.toHaveBeenCalled();
    expect(facts).toEqual({
      days: [{ adjustment_id: 77, employee_id: 523, work_date: '2026-09-06' }],
      requests: [{ request_id: 900, employee_id: 1600, work_date: '2026-09-13' }],
    });
  });

  it('отдел: окно членства viaTransferOnly — и для дней, и для заявлений', async () => {
    mockListMemberships.mockResolvedValue([
      // Вошёл переводом 10.09: выход 06.09 — до перевода, не наш.
      { employee_id: 7, joined_date: '2026-09-10', transferred_out_date: null, joined_via_transfer: true },
      // «Грязный» effective_from без перевода — нижнюю границу не применяем.
      { employee_id: 8, joined_date: '2026-09-10', transferred_out_date: null, joined_via_transfer: false },
      // Переведён из отдела 12.09: день перевода уже не наш.
      { employee_id: 9, joined_date: null, transferred_out_date: '2026-09-12', joined_via_transfer: false },
    ]);
    setupQueries({
      days: [
        { id: 1, employee_id: 7, work_date: '2026-09-06' },
        { id: 2, employee_id: 8, work_date: '2026-09-06' },
        { id: 3, employee_id: 9, work_date: '2026-09-12' },
      ],
      requests: [
        { request_id: 11, employee_id: 7, work_date: '2026-09-13' },
        { request_id: 12, employee_id: 9, work_date: '2026-09-13' },
      ],
    });

    const facts = await listPendingDecisionFacts(DEPT, RANGE);

    expect(facts.days.map(d => d.adjustment_id)).toEqual([2]);
    expect(facts.requests.map(d => d.request_id)).toEqual([11]);
  });

  it('с клиентом транзакции читает через него (и членство, и факты)', async () => {
    mockListMemberships.mockResolvedValue([
      { employee_id: 1, joined_date: null, transferred_out_date: null, joined_via_transfer: false },
    ]);
    const exec = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes('FROM leave_requests') ? [] : [{ id: 5, employee_id: 1, work_date: '2026-09-06' }],
      })),
    };

    const facts = await listPendingDecisionFacts(DEPT, RANGE, exec as never);

    expect(facts.days).toEqual([{ adjustment_id: 5, employee_id: 1, work_date: '2026-09-06' }]);
    expect(mockListMemberships).toHaveBeenCalledWith('dept-disp', RANGE.startDate, RANGE.endDate, exec);
    expect(exec.query).toHaveBeenCalledTimes(2);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('countPendingDecisionDays', () => {
  it('день у согласующего и заявление на тот же день, две строки одного дня — один день', () => {
    expect(countPendingDecisionDays({
      days: [
        { adjustment_id: 1, employee_id: 7, work_date: '2026-09-06' },
        { adjustment_id: 2, employee_id: 7, work_date: '2026-09-06' },
        { adjustment_id: 3, employee_id: 8, work_date: '2026-09-06' },
      ],
      requests: [
        { request_id: 11, employee_id: 7, work_date: '2026-09-06' },
        { request_id: 12, employee_id: 7, work_date: '2026-09-13' },
      ],
    })).toBe(3);
  });
});

describe('countPendingDecisionsForApproval', () => {
  it('персональная подача — по видимому снимку (уволенных в составе нет)', async () => {
    mockVisibleSnapshot.mockResolvedValue([{ employee_id: 523, full_name: 'Демчук' }]);
    setupQueries({ days: [{ id: 77, employee_id: 523, work_date: '2026-09-06' }] });

    const count = await countPendingDecisionsForApproval({
      id: 1831, department_id: null, manager_employee_id: 2063,
      start_date: RANGE.startDate, end_date: RANGE.endDate,
    });

    expect(count).toBe(1);
    expect(mockListMemberships).not.toHaveBeenCalled();
    const [, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toEqual([523]);
  });

  it('подача без состава — 0 без запросов', async () => {
    const count = await countPendingDecisionsForApproval({
      id: 1, department_id: null, manager_employee_id: null,
      start_date: RANGE.startDate, end_date: RANGE.endDate,
    });
    expect(count).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('describePendingDecisions', () => {
  it('группы по набору согласующих: 2-й этап по маршруту дня, 1-й — с заместителями', async () => {
    setupQueries({
      employees: [
        { id: 523, org_department_id: 'D1', full_name: 'Демчук Анна Александровна' },
        { id: 1600, org_department_id: 'D1', full_name: 'Сары Мария Петровна' },
        { id: 2063, full_name: 'Чепиков Алексей Владимирович' },
        { id: 55, full_name: 'Иванов Иван Иванович' },
        { id: 31, full_name: 'Петров Пётр Петрович' },
      ],
    });
    mockRouteRows.mockResolvedValue(new Map([[77, [2063]], [78, [2063]], [79, []]]));
    // Порядок согласующих из маршрута не важен — ключ группы по отсортированным id.
    mockLeaveApprovers.mockResolvedValue(new Map([[1600, [55, 31]]]));

    const groups = await describePendingDecisions({
      days: [
        { adjustment_id: 78, employee_id: 523, work_date: '2026-09-13' },
        { adjustment_id: 77, employee_id: 523, work_date: '2026-09-06' },
        { adjustment_id: 79, employee_id: 1600, work_date: '2026-09-07' },
      ],
      requests: [
        { request_id: 900, employee_id: 1600, work_date: '2026-09-14' },
        { request_id: 901, employee_id: 1600, work_date: '2026-09-14' },
      ],
    });

    expect(groups).toEqual([
      { stage: 'day', responsible_employee_ids: [2063], responsible_names: ['Чепиков Алексей Владимирович'], days: ['2026-09-06', '2026-09-13'] },
      { stage: 'day', responsible_employee_ids: [], responsible_names: [], days: ['2026-09-07'] },
      { stage: 'request', responsible_employee_ids: [31, 55], responsible_names: ['Петров Пётр Петрович', 'Иванов Иван Иванович'], days: ['2026-09-14'] },
    ]);
    expect(mockRouteRows.mock.calls[0][0]).toContainEqual(
      { id: 77, employee_id: 523, work_date: '2026-09-06', org_department_id: 'D1' },
    );
    expect(mockLeaveApprovers).toHaveBeenCalledWith([{ employee_id: 1600, org_department_id: 'D1' }]);
  });

  it('ничего не ждёт — пусто без запросов', async () => {
    expect(await describePendingDecisions({ days: [], requests: [] })).toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
