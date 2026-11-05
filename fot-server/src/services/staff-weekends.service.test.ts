import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Выходные» кадров (миграция 346). Правила дня проверяет тест validateCorrectionAttachments, здесь — что поверх него:
 * состав и окна по двум отделам, отдел строки, сумма минут, охват и несколько месяцев.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  validate: vi.fn(),
  memberships: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));
vi.mock('./timesheet-approval-correction-validation.service.js', () => ({
  validateCorrectionAttachments: h.validate,
}));
vi.mock('./timesheet-department-assignments.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./timesheet-department-assignments.service.js')>()),
  listEmployeeMembershipsForDepartmentPeriod: h.memberships,
}));

const {
  listWeekendsWithoutCorrection,
  STAFF_WEEKENDS_BRANCH_IDS,
  STAFF_WEEKENDS_MAX_MONTHS,
} = await import('./staff-weekends.service.js');

const [LINE, GENERAL] = STAFF_WEEKENDS_BRANCH_IDS as [string, string];
const BOTH = [LINE, GENERAL];

interface IMembershipFixture {
  employee_id: number;
  transferred_out_date?: string | null;
  joined_date?: string | null;
  joined_via_transfer?: boolean;
}

/** Состав по отделам; месяц не важен, если не задан отдельно. */
const givenMembers = (byBranch: Record<string, IMembershipFixture[]>): void => {
  h.memberships.mockImplementation(async (branchId: string) => (byBranch[branchId] ?? []).map(member => ({
    transferred_out_date: null,
    joined_date: null,
    joined_via_transfer: false,
    ...member,
  })));
};

const weekendDay = (employeeId: number, date: string) => ({
  date,
  employee_id: employeeId,
  employee_name: null,
  kind: 'weekend_no_correction',
  reason: '',
});

const givenDays = (...missing: Array<ReturnType<typeof weekendDay>>): void => {
  h.validate.mockResolvedValue({ ok: false, missing });
};

/** Ответы трёх запросов сервиса. minutes — «сотрудник|день» → минуты. */
const givenDetails = (
  employees: Array<{ id: number; full_name: string | null; position?: string | null }>,
  minutes: Record<string, number> = {},
): void => {
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employees')) return employees.map(employee => ({ position: null, ...employee }));
    if (sql.includes('FROM skud_daily_summary')) {
      return Object.entries(minutes).map(([key, total]) => {
        const [employeeId, date] = key.split('|');
        return { employee_id: Number(employeeId), date, total_minutes: total };
      });
    }
    if (sql.includes('FROM org_departments')) {
      return [{ id: LINE, name: 'ЛИНИЯ' }, { id: GENERAL, name: 'ЛИНИЯ-Общестрой' }];
    }
    throw new Error(`неожиданный запрос: ${sql}`);
  });
};

beforeEach(() => {
  h.query.mockReset();
  h.validate.mockReset();
  h.memberships.mockReset();
});

describe('listWeekendsWithoutCorrection', () => {
  it('лимит месяцев и два отдела', () => {
    expect(STAFF_WEEKENDS_MAX_MONTHS).toBe(12);
    expect(STAFF_WEEKENDS_BRANCH_IDS).toHaveLength(2);
  });

  it('минуты суммируются только по показанным дням, даты — по порядку, должность и ФИО из карточки', async () => {
    givenMembers({ [LINE]: [{ employee_id: 1 }] });
    givenDays(weekendDay(1, '2026-10-11'), weekendDay(1, '2026-10-04'));
    givenDetails(
      [{ id: 1, full_name: 'Джумаев А. Х.', position: 'Начальник участка' }],
      { '1|2026-10-04': 516, '1|2026-10-11': 6, '1|2026-10-10': 498 },
    );

    expect(await listWeekendsWithoutCorrection(['2026-10'], BOTH)).toEqual([{
      employee_id: 1,
      full_name: 'Джумаев А. Х.',
      department: 'ЛИНИЯ',
      position: 'Начальник участка',
      days: ['2026-10-04', '2026-10-11'],
      total_minutes: 522,
    }]);
  });

  it('перевод ЛИНИЯ → ЛИНИЯ-Общестрой в месяце: дни обоих отрезков, отдел — по последнему дню, квота плановых общая', async () => {
    givenMembers({
      [LINE]: [{ employee_id: 1, transferred_out_date: '2026-10-16' }],
      [GENERAL]: [{ employee_id: 1, joined_date: '2026-10-16', joined_via_transfer: true }],
    });
    givenDays(weekendDay(1, '2026-10-11'), weekendDay(1, '2026-10-25'));
    givenDetails([{ id: 1, full_name: 'Иванов' }]);

    const [row] = await listWeekendsWithoutCorrection(['2026-10'], BOTH);

    // Окно второго отдела не затёрло первое: 11.10 (ещё в ЛИНИЯ) на месте.
    expect(row?.days).toEqual(['2026-10-11', '2026-10-25']);
    expect(row?.department).toBe('ЛИНИЯ-Общестрой');
    // Один вызов на сотрудника за месяц: квота плановых суббот считается на человека, а не на отрезок.
    expect(h.validate).toHaveBeenCalledTimes(1);
    expect(h.validate.mock.calls[0]?.[0]).toEqual({ kind: 'personal', employeeIds: [1] });
  });

  it('обратный перевод: последний день в ЛИНИЯ — в строке ЛИНИЯ', async () => {
    givenMembers({
      [GENERAL]: [{ employee_id: 1, transferred_out_date: '2026-10-16' }],
      [LINE]: [{ employee_id: 1, joined_date: '2026-10-16', joined_via_transfer: true }],
    });
    givenDays(weekendDay(1, '2026-10-11'), weekendDay(1, '2026-10-25'));
    givenDetails([{ id: 1, full_name: 'Иванов' }]);

    const [row] = await listWeekendsWithoutCorrection(['2026-10'], BOTH);

    expect(row?.days).toEqual(['2026-10-11', '2026-10-25']);
    expect(row?.department).toBe('ЛИНИЯ');
  });

  it('уволенный: виден в месяце увольнения до его даты, отдел — прежний, а не «Уволенные»', async () => {
    givenMembers({ [GENERAL]: [{ employee_id: 2, transferred_out_date: '2026-10-31' }] });
    givenDays(weekendDay(2, '2026-10-25'), weekendDay(2, '2026-10-31'));
    givenDetails([{ id: 2, full_name: 'Тошмуродов' }]);

    const [row] = await listWeekendsWithoutCorrection(['2026-10'], BOTH);

    expect(row?.days).toEqual(['2026-10-25']);
    expect(row?.department).toBe('ЛИНИЯ-Общестрой');
    expect(h.memberships).toHaveBeenCalledWith(GENERAL, '2026-10-01', '2026-10-31', undefined, { firedInDismissalMonth: true });
  });

  it('нижняя граница окна — только при настоящем переводе, «грязный» effective_from дни не режет', async () => {
    givenMembers({
      [LINE]: [
        { employee_id: 1, joined_date: '2026-10-20', joined_via_transfer: false },
        { employee_id: 2, joined_date: '2026-10-20', joined_via_transfer: true },
      ],
    });
    givenDays(weekendDay(1, '2026-10-11'), weekendDay(2, '2026-10-11'), weekendDay(2, '2026-10-25'));
    givenDetails([{ id: 1, full_name: 'Грязная дата' }, { id: 2, full_name: 'Настоящий перевод' }]);

    const rows = await listWeekendsWithoutCorrection(['2026-10'], BOTH);

    expect(rows.find(row => row.employee_id === 1)?.days).toEqual(['2026-10-11']);
    expect(rows.find(row => row.employee_id === 2)?.days).toEqual(['2026-10-25']);
  });

  it('сотрудник без окна (не из этих отделов) в список не попадает', async () => {
    givenMembers({ [LINE]: [{ employee_id: 1 }] });
    givenDays(weekendDay(1, '2026-10-04'), weekendDay(999, '2026-10-04'));
    givenDetails([{ id: 1, full_name: 'Иванов' }]);

    const rows = await listWeekendsWithoutCorrection(['2026-10'], BOTH);

    expect(rows.map(row => row.employee_id)).toEqual([1]);
    const detailCall = h.query.mock.calls.find(([sql]) => String(sql).includes('FROM employees'));
    expect(detailCall?.[1]).toEqual([[1]]);
  });

  it('охват: передан один отдел — состав и дни только его', async () => {
    givenMembers({ [LINE]: [{ employee_id: 1 }], [GENERAL]: [{ employee_id: 2 }] });
    givenDays(weekendDay(2, '2026-10-04'));
    givenDetails([{ id: 2, full_name: 'Петров' }]);

    const rows = await listWeekendsWithoutCorrection(['2026-10'], [GENERAL]);

    expect(rows.map(row => row.department)).toEqual(['ЛИНИЯ-Общестрой']);
    expect(h.memberships).toHaveBeenCalledTimes(1);
    expect(h.validate.mock.calls[0]?.[0]).toEqual({ kind: 'personal', employeeIds: [2] });
  });

  it('охват: ни одного отдела — пусто и без запросов', async () => {
    expect(await listWeekendsWithoutCorrection(['2026-10'], [])).toEqual([]);
    expect(h.memberships).not.toHaveBeenCalled();
    expect(h.validate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('несколько месяцев: проверка на каждый месяц, дни в одной строке без повторов', async () => {
    givenMembers({ [LINE]: [{ employee_id: 1 }] });
    h.validate
      .mockResolvedValueOnce({ ok: false, missing: [weekendDay(1, '2026-10-04')] })
      .mockResolvedValueOnce({ ok: false, missing: [weekendDay(1, '2026-11-01')] });
    givenDetails([{ id: 1, full_name: 'Иванов' }], { '1|2026-10-04': 60, '1|2026-11-01': 30 });

    const rows = await listWeekendsWithoutCorrection(['2026-10', '2026-11'], BOTH);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.days).toEqual(['2026-10-04', '2026-11-01']);
    expect(rows[0]?.total_minutes).toBe(90);
    expect(h.validate).toHaveBeenCalledTimes(2);
    expect(h.validate.mock.calls[1]?.[1]).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-30' });
  });

  it('заявления из проверки подачи не показываются, только выходные без корректировки', async () => {
    givenMembers({ [LINE]: [{ employee_id: 1 }] });
    h.validate.mockResolvedValue({
      ok: false,
      missing: [{ date: '2026-10-04', employee_id: 1, employee_name: null, kind: 'leave_request', reason: '' }],
    });

    expect(await listWeekendsWithoutCorrection(['2026-10'], BOTH)).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('проверка прошла или в отделах никого — пустой список', async () => {
    givenMembers({ [LINE]: [{ employee_id: 1 }] });
    h.validate.mockResolvedValue({ ok: true });
    expect(await listWeekendsWithoutCorrection(['2026-10'], BOTH)).toEqual([]);

    h.validate.mockClear();
    givenMembers({});
    expect(await listWeekendsWithoutCorrection(['2026-10'], BOTH)).toEqual([]);
    expect(h.validate).not.toHaveBeenCalled();
  });

  it('порядок — по ФИО', async () => {
    givenMembers({ [LINE]: [{ employee_id: 1 }, { employee_id: 2 }] });
    givenDays(weekendDay(1, '2026-10-04'), weekendDay(2, '2026-10-04'));
    givenDetails([{ id: 1, full_name: 'Яковлев' }, { id: 2, full_name: 'Абдуллаев' }]);

    const rows = await listWeekendsWithoutCorrection(['2026-10'], BOTH);

    expect(rows.map(row => row.full_name)).toEqual(['Абдуллаев', 'Яковлев']);
  });
});
