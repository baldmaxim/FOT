import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { mockGetOffDatesByEmployee, mockResolveSchedulesForPeriod, mockLoadCalendarMonth } = vi.hoisted(() => ({
  mockGetOffDatesByEmployee: vi.fn(),
  mockResolveSchedulesForPeriod: vi.fn(),
  mockLoadCalendarMonth: vi.fn(),
}));
vi.mock('./timesheet-approval-weekend-check.service.js', () => ({
  getOffDatesByEmployee: mockGetOffDatesByEmployee,
}));

vi.mock('./schedule.service.js', () => ({
  resolveSchedulesForPeriod: mockResolveSchedulesForPeriod,
  loadCalendarMonth: mockLoadCalendarMonth,
}));

vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(),
}));

const { mockListNonHolidayWeekendDays } = vi.hoisted(() => ({
  mockListNonHolidayWeekendDays: vi.fn(),
}));
vi.mock('../controllers/timesheet.controller.js', () => ({
  listNonHolidayWeekendDays: mockListNonHolidayWeekendDays,
}));

import { validateCorrectionAttachments } from './timesheet-approval-correction-validation.service.js';

const RANGE = { startDate: '2026-05-01', endDate: '2026-05-31' };

type SkudRow = { employee_id: number; date: string; total_minutes: number };
type AdjRow = { employee_id: number; work_date: string };
type LeaveRow = {
  id: number;
  employee_id: number;
  request_type: string;
  start_date: string;
  end_date: string;
  correction_date: string | null;
};
type EmpRow = { id: number; full_name: string | null };
type DocLinkRow = { entity_id: string };

interface IFixture {
  adjustments?: AdjRow[];
  leaves?: LeaveRow[];
  docLinks?: DocLinkRow[];
  skud?: SkudRow[];
  employees?: EmpRow[];
}

function setupQueries(fx: IFixture): void {
  pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM attendance_adjustments')) return fx.adjustments ?? [];
    if (sql.includes('FROM leave_requests')) return fx.leaves ?? [];
    if (sql.includes('FROM document_links')) return fx.docLinks ?? [];
    if (sql.includes('FROM skud_daily_summary')) return fx.skud ?? [];
    if (sql.includes('FROM employees')) return fx.employees ?? [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

function setupMocks(): void {
  mockResolveSchedulesForPeriod.mockResolvedValue(new Map());
  mockLoadCalendarMonth.mockResolvedValue(null);
  mockListNonHolidayWeekendDays.mockReturnValue([]);
}

beforeEach(() => {
  pgQuery.mockReset();
  mockGetOffDatesByEmployee.mockReset();
  mockResolveSchedulesForPeriod.mockReset();
  mockLoadCalendarMonth.mockReset();
  mockListNonHolidayWeekendDays.mockReset();
  setupMocks();
});

describe('validateCorrectionAttachments', () => {
  it('6+0, respects_holidays=false: СКУД в Сб и Вс → ok (нерабочих дней нет)', async () => {
    mockGetOffDatesByEmployee.mockResolvedValue(new Map([[1, new Set<string>()]]));
    setupQueries({
      skud: [
        { employee_id: 1, date: '2026-05-02', total_minutes: 480 }, // Сб
        { employee_id: 1, date: '2026-05-03', total_minutes: 480 }, // Вс
      ],
    });

    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [1] },
      RANGE,
    );

    expect(result.ok).toBe(true);
  });

  it('6+0, respects_holidays=false: СКУД на mandatory_holiday без корректировки → блок', async () => {
    mockGetOffDatesByEmployee.mockResolvedValue(
      new Map([[1, new Set(['2026-05-01'])]]),
    );
    setupQueries({
      skud: [{ employee_id: 1, date: '2026-05-01', total_minutes: 480 }],
      employees: [{ id: 1, full_name: 'Иванов И.И.' }],
    });

    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [1] },
      RANGE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]).toMatchObject({
        date: '2026-05-01',
        employee_id: 1,
        kind: 'weekend_no_correction',
      });
    }
  });

  it('5+2, respects_holidays=true: СКУД в субботу без корректировки → блок', async () => {
    mockGetOffDatesByEmployee.mockResolvedValue(
      new Map([[2, new Set(['2026-05-02', '2026-05-03'])]]),
    );
    setupQueries({
      skud: [{ employee_id: 2, date: '2026-05-02', total_minutes: 360 }],
      employees: [{ id: 2, full_name: 'Петров П.П.' }],
    });

    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [2] },
      RANGE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing[0].kind).toBe('weekend_no_correction');
      expect(result.missing[0].date).toBe('2026-05-02');
    }
  });

  it('5+2: СКУД в субботу + корректировка на ту же дату → ok', async () => {
    mockGetOffDatesByEmployee.mockResolvedValue(
      new Map([[2, new Set(['2026-05-02', '2026-05-03'])]]),
    );
    setupQueries({
      adjustments: [{ employee_id: 2, work_date: '2026-05-02' }],
      skud: [{ employee_id: 2, date: '2026-05-02', total_minutes: 360 }],
    });

    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [2] },
      RANGE,
    );

    expect(result.ok).toBe(true);
  });

  it('Цикл 2+2, рабочий слот на воскресенье → СКУД без корректировки → ok', async () => {
    // 03.05.2026 — воскресенье, но рабочий по циклу → не в off-set
    mockGetOffDatesByEmployee.mockResolvedValue(
      new Map([[3, new Set(['2026-05-04', '2026-05-05'])]]),
    );
    setupQueries({
      skud: [{ employee_id: 3, date: '2026-05-03', total_minutes: 660 }],
    });

    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [3] },
      RANGE,
    );

    expect(result.ok).toBe(true);
  });

  it('Смешанная бригада: 6+0 не блокирует, 5+2 в субботу без корректировки блокирует', async () => {
    mockGetOffDatesByEmployee.mockResolvedValue(
      new Map([
        [10, new Set<string>()],                 // 6+0 — нет выходных
        [20, new Set(['2026-05-02'])],           // 5+2 — суббота выходная
      ]),
    );
    setupQueries({
      skud: [
        { employee_id: 10, date: '2026-05-02', total_minutes: 480 },
        { employee_id: 20, date: '2026-05-02', total_minutes: 480 },
      ],
      employees: [{ id: 20, full_name: 'Сидоров С.С.' }],
    });

    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [10, 20] },
      RANGE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0].employee_id).toBe(20);
    }
  });

  it('leave_request vacation без вложения → блок (ортогональная ветка сохранена)', async () => {
    mockGetOffDatesByEmployee.mockResolvedValue(new Map([[1, new Set<string>()]]));
    setupQueries({
      leaves: [{
        id: 555,
        employee_id: 1,
        request_type: 'vacation',
        start_date: '2026-05-10',
        end_date: '2026-05-10',
        correction_date: null,
      }],
      docLinks: [], // нет вложения
      employees: [{ id: 1, full_name: 'Иванов И.И.' }],
    });

    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [1] },
      RANGE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing[0].kind).toBe('leave_request');
      expect(result.missing[0].reason).toContain('Отпуск');
    }
  });

  it('leave_request remote с вложением → ok', async () => {
    mockGetOffDatesByEmployee.mockResolvedValue(new Map([[1, new Set<string>()]]));
    setupQueries({
      leaves: [{
        id: 555,
        employee_id: 1,
        request_type: 'remote',
        start_date: '2026-05-10',
        end_date: '2026-05-10',
        correction_date: null,
      }],
      docLinks: [{ entity_id: '555' }],
    });

    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [1] },
      RANGE,
    );

    expect(result.ok).toBe(true);
  });

  it('пустой список employees → ok без обращений к БД', async () => {
    const result = await validateCorrectionAttachments(
      { kind: 'personal', employeeIds: [] },
      RANGE,
    );

    expect(result.ok).toBe(true);
    expect(pgQuery).not.toHaveBeenCalled();
    expect(mockGetOffDatesByEmployee).not.toHaveBeenCalled();
  });
});
