import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокаем источники данных состава персональной подачи: pg-query (eligibility +
// вычитание уже поданных отделом), прямые подчинённые за период и покрытие отделом.
const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
}));

const { listDirectReportIdsInPeriodMock } = vi.hoisted(() => ({
  listDirectReportIdsInPeriodMock: vi.fn(),
}));
vi.mock('../services/employee-direct-reports.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/employee-direct-reports.service.js')>()),
  listDirectReportIdsInPeriod: listDirectReportIdsInPeriodMock,
}));

const { splitMock } = vi.hoisted(() => ({ splitMock: vi.fn() }));
vi.mock('../services/direct-report-coverage.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/direct-report-coverage.service.js')>()),
  splitDirectReportsByCoverage: splitMock,
}));

import { resolvePersonalSubmissionContext } from './timesheet-approval.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const MANAGER = 233;
const SUB_A = 501;
const SUB_B = 502;
const RANGE = { startDate: '2026-09-01', endDate: '2026-09-15' };

const makeReq = (employeeId: number | null): AuthenticatedRequest =>
  ({ user: { employee_id: employeeId } } as unknown as AuthenticatedRequest);

/** Разбиение по умолчанию: всех ведёт сам руководитель. */
const splitAllOwned = (ids: number[]) => ({
  owned: ids, fullyCovered: [], partiallyCovered: [], coveredDates: new Map(),
});

/** pgQuery: первый вызов — eligibility, второй — уже поданные отделом. */
const mockQueries = (
  eligible: Array<{ id: number; org_department_id: string | null }>,
  coveredByDepartment: number[] = [],
) => {
  pgQuery.mockReset();
  pgQuery
    .mockResolvedValueOnce(eligible)
    .mockResolvedValueOnce(coveredByDepartment.map(id => ({ employee_id: id })));
};

beforeEach(() => {
  vi.clearAllMocks();
  splitMock.mockImplementation(async (ids: number[]) => splitAllOwned([...ids]));
});

describe('resolvePersonalSubmissionContext — состав персональной подачи', () => {
  it('включает самого руководителя вместе с подчинёнными за период', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A, SUB_B]);
    mockQueries([
      { id: MANAGER, org_department_id: 'DM' },
      { id: SUB_A, org_department_id: 'D1' },
      { id: SUB_B, org_department_id: 'D1' },
    ]);

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);

    expect(ctx).not.toBeNull();
    expect(ctx?.managerEmployeeId).toBe(MANAGER);
    // Руководитель присутствует ровно один раз.
    expect(ctx?.employeeIds.filter(id => id === MANAGER)).toEqual([MANAGER]);
    expect(ctx?.employeeIds).toEqual(expect.arrayContaining([MANAGER, SUB_A, SUB_B]));
    expect(ctx?.affectedDepartmentIds).toEqual(expect.arrayContaining(['DM', 'D1']));
    // Кандидаты переданы в query без дублей: руководитель + подчинённые.
    expect(pgQuery.mock.calls[0][1]).toEqual([[MANAGER, SUB_A, SUB_B], RANGE.startDate]);
  });

  it('подчинённого, которого весь период ведёт руководитель отдела, в составе нет', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A, SUB_B]);
    splitMock.mockResolvedValue({
      owned: [MANAGER, SUB_A],
      fullyCovered: [SUB_B],
      partiallyCovered: [],
      coveredDates: new Map([[SUB_B, ['2026-09-01']]]),
    });
    mockQueries([
      { id: MANAGER, org_department_id: 'DM' },
      { id: SUB_A, org_department_id: 'D1' },
    ]);

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);

    expect(ctx?.employeeIds).toEqual([MANAGER, SUB_A].sort((l, r) => l - r));
    // Покрытый вообще не доходит до выборки eligibility.
    expect(pgQuery.mock.calls[0][1]).toEqual([[MANAGER, SUB_A], RANGE.startDate]);
  });

  it('частично покрытый остаётся в составе: его непокрытые дни ведёт личный руководитель', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A]);
    splitMock.mockResolvedValue({
      owned: [MANAGER],
      fullyCovered: [],
      partiallyCovered: [SUB_A],
      coveredDates: new Map([[SUB_A, ['2026-09-01', '2026-09-02']]]),
    });
    mockQueries([
      { id: MANAGER, org_department_id: 'DM' },
      { id: SUB_A, org_department_id: 'D1' },
    ]);

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);

    expect(ctx?.employeeIds).toContain(SUB_A);
  });

  it('уже поданных подачей отдела вычитаем — включая самого руководителя', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A]);
    mockQueries(
      [{ id: MANAGER, org_department_id: 'DM' }, { id: SUB_A, org_department_id: 'D1' }],
      [MANAGER],
    );

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);

    expect(ctx?.employeeIds).toEqual([SUB_A]);
  });

  it('весь состав уехал в подачи отделов → null (persona-подача не нужна)', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A]);
    mockQueries(
      [{ id: MANAGER, org_department_id: 'DM' }, { id: SUB_A, org_department_id: 'D1' }],
      [MANAGER, SUB_A],
    );

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);

    expect(ctx).toBeNull();
  });

  it('нет employee_id → null (query не вызывается)', async () => {
    const ctx = await resolvePersonalSubmissionContext(makeReq(null), RANGE);
    expect(ctx).toBeNull();
    expect(listDirectReportIdsInPeriodMock).not.toHaveBeenCalled();
  });

  it('руководитель идёт в один split с подчинёнными и без viewer', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A, SUB_B]);
    mockQueries([
      { id: MANAGER, org_department_id: 'DM' },
      { id: SUB_A, org_department_id: 'D1' },
      { id: SUB_B, org_department_id: 'D1' },
    ]);

    await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);

    expect(splitMock).toHaveBeenCalledTimes(1);
    // Без viewer (5-й аргумент): владелец своего отдела тоже «покрывает» себя.
    expect(splitMock.mock.calls[0]).toEqual([[MANAGER, SUB_A, SUB_B], RANGE.startDate, RANGE.endDate]);
  });

  it('у своего отдела руководителя есть владелец табеля → его строки в составе нет', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A]);
    splitMock.mockResolvedValue({
      owned: [SUB_A],
      fullyCovered: [MANAGER],
      partiallyCovered: [],
      coveredDates: new Map([[MANAGER, ['2026-09-01']]]),
    });
    mockQueries([{ id: SUB_A, org_department_id: 'D1' }]);

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);

    expect(ctx?.employeeIds).toEqual([SUB_A]);
    expect(ctx?.managerEmployeeId).toBe(MANAGER);
    // Покрытый руководитель не доходит даже до eligibility.
    expect(pgQuery.mock.calls[0][1]).toEqual([[SUB_A], RANGE.startDate]);
  });

  it('руководитель покрыт, лично назначенных вне отделов нет → null, запросов нет', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A]);
    splitMock.mockResolvedValue({
      owned: [],
      fullyCovered: [MANAGER, SUB_A],
      partiallyCovered: [],
      coveredDates: new Map(),
    });

    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);

    expect(ctx).toBeNull();
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('частично покрытый руководитель остаётся, но уже поданный отделом — вычитается целиком', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([SUB_A]);
    splitMock.mockResolvedValue({
      owned: [SUB_A],
      fullyCovered: [],
      partiallyCovered: [MANAGER],
      coveredDates: new Map([[MANAGER, ['2026-09-10']]]),
    });

    mockQueries([{ id: MANAGER, org_department_id: 'DM' }, { id: SUB_A, org_department_id: 'D1' }]);
    expect((await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE))?.employeeIds)
      .toEqual([MANAGER, SUB_A].sort((l, r) => l - r));

    // Пересекающаяся подача отдела уже содержит его строку — текущее поведение coveredRows.
    mockQueries([{ id: MANAGER, org_department_id: 'DM' }, { id: SUB_A, org_department_id: 'D1' }], [MANAGER]);
    expect((await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE))?.employeeIds).toEqual([SUB_A]);
  });

  it('нет подчинённых → null', async () => {
    listDirectReportIdsInPeriodMock.mockResolvedValue([]);
    mockQueries([{ id: MANAGER, org_department_id: 'DM' }]);
    const ctx = await resolvePersonalSubmissionContext(makeReq(MANAGER), RANGE);
    expect(ctx).toBeNull();
  });
});
