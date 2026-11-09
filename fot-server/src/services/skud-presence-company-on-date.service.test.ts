import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Компания на дату прохода: история назначений с той же трактовкой «Уволенных», что
 * сегменты переводов 1С; промежутки, дата до первой записи, увольнения (в т.ч. отменённые
 * и повторные), сотрудник без истории и одноимённые компании.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

interface IAssignmentRow {
  id: string;
  employee_id: number;
  org_department_id: string | null;
  effective_from: string;
  effective_to: string | null;
}
interface IDismissalRow {
  employee_id: number;
  from_department_id: string;
  dismissal_date: string;
  cancelled?: boolean;
}

const ARCHIVE = 'dept-archive';

const state = vi.hoisted(() => ({
  assignments: [] as IAssignmentRow[],
  employees: [] as Array<{ id: number; org_department_id: string | null }>,
  dismissals: [] as IDismissalRow[],
}));

vi.mock('./skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(),
  getCompanyResolveIndex: vi.fn(async () => ({
    rootId: 'root',
    companyByDeptId: new Map([
      ['dept-su10', 'company-su10'],
      ['dept-su10-b', 'company-su10'],
      ['dept-liniya', 'company-liniya'],
      ['dept-twin', 'company-twin'],
      [ARCHIVE, 'company-archive'],
    ]),
    companyMeta: new Map([
      ['company-su10', { id: 'company-su10', name: 'СУ-10', sigur_department_id: 10 }],
      ['company-liniya', { id: 'company-liniya', name: 'ЛИНИЯ', sigur_department_id: 20 }],
      // Одноимённая с СУ-10, но другая компания.
      ['company-twin', { id: 'company-twin', name: 'СУ-10', sigur_department_id: 30 }],
      ['company-archive', { id: 'company-archive', name: 'Уволенные', sigur_department_id: 99 }],
    ]),
    companyBySigurId: new Map(),
    companyByNormalizedName: new Map(),
  })),
}));

const { loadCompanyOnDateSource, resolveCompanyOnDate, resolveDeptOnDate, NO_COMPANY } = await import(
  './skud-presence-company-on-date.service.js'
);

beforeEach(() => {
  state.assignments = [];
  state.employees = [];
  state.dismissals = [];
  pgQuery.mockReset();
  pgQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const ids = new Set(params[0] as number[]);
    if (sql.includes('FROM employee_assignments')) {
      return state.assignments.filter(row => ids.has(row.employee_id));
    }
    if (sql.includes('FROM employee_dismissal_events')) {
      // Повторяет WHERE загрузчика: неотменённые, не в архив, по дате.
      return state.dismissals
        .filter(row => ids.has(row.employee_id) && !row.cancelled && row.from_department_id !== params[1])
        .sort((a, b) => a.employee_id - b.employee_id || a.dismissal_date.localeCompare(b.dismissal_date));
    }
    if (sql.includes('FROM employees')) return state.employees.filter(row => ids.has(row.id));
    return [];
  });
});

const assignment = (
  id: string, employeeId: number, dept: string | null, from: string, to: string | null,
): IAssignmentRow => ({ id, employee_id: employeeId, org_department_id: dept, effective_from: from, effective_to: to });

const load = () => loadCompanyOnDateSource([1], ARCHIVE);

describe('resolveDeptOnDate', () => {
  it('перевод в середине месяца: до — старый отдел, с даты перевода — новый', async () => {
    state.assignments = [
      assignment('a1', 1, 'dept-su10', '2025-01-10', '2026-09-14'),
      assignment('a2', 1, 'dept-liniya', '2026-09-15', null),
    ];
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-14')).toBe('dept-su10');
    expect(resolveDeptOnDate(source, 1, '2026-09-15')).toBe('dept-liniya');
  });

  it('промежуток между назначениями — предыдущее, а не текущий отдел', async () => {
    state.employees = [{ id: 1, org_department_id: 'dept-liniya' }];
    state.assignments = [
      assignment('a1', 1, 'dept-su10', '2026-01-01', '2026-08-31'),
      assignment('a2', 1, 'dept-liniya', '2026-10-01', null),
    ];
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-10')).toBe('dept-su10');
  });

  it('дата раньше первой записи — первое назначение', async () => {
    state.assignments = [assignment('a1', 1, 'dept-liniya', '2026-09-20', null)];
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-02')).toBe('dept-liniya');
  });

  it('уволен после периода: «Уволенные» не попадают, остаётся рабочий отдел', async () => {
    state.employees = [{ id: 1, org_department_id: ARCHIVE }];
    state.assignments = [
      assignment('a1', 1, 'dept-su10', '2025-03-01', '2026-10-15'),
      assignment('a2', 1, ARCHIVE, '2026-10-16', null),
    ];
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-10')).toBe('dept-su10');
    // И даже после даты увольнения — промежуток увольнения относится к прошлому отделу.
    expect(resolveDeptOnDate(source, 1, '2026-10-20')).toBe('dept-su10');
  });

  it('уволен и повторно принят: промежуток «Уволенных» — к предыдущему отделу', async () => {
    state.assignments = [
      assignment('a1', 1, 'dept-su10', '2026-01-01', '2026-08-31'),
      assignment('a2', 1, ARCHIVE, '2026-09-01', '2026-09-09'),
      assignment('a3', 1, 'dept-liniya', '2026-09-10', null),
    ];
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-05')).toBe('dept-su10');
    expect(resolveDeptOnDate(source, 1, '2026-09-10')).toBe('dept-liniya');
  });

  it('несколько назначений на дату — последнее в порядке effective_from, id', async () => {
    state.assignments = [
      assignment('b', 1, 'dept-liniya', '2026-09-01', null),
      assignment('a', 1, 'dept-su10', '2026-09-01', null),
    ];
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-05')).toBe('dept-liniya');
  });

  it('назначений нет — текущий отдел', async () => {
    state.employees = [{ id: 1, org_department_id: 'dept-liniya' }];
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-05')).toBe('dept-liniya');
  });

  it('только «Уволенные» без донора — отдел ближайшего увольнения, отменённое не учитывается', async () => {
    state.employees = [{ id: 1, org_department_id: ARCHIVE }];
    state.assignments = [assignment('a1', 1, ARCHIVE, '2026-11-01', null)];
    state.dismissals = [
      { employee_id: 1, from_department_id: 'dept-su10', dismissal_date: '2026-06-30' },
      { employee_id: 1, from_department_id: 'dept-twin', dismissal_date: '2026-09-20', cancelled: true },
      { employee_id: 1, from_department_id: 'dept-liniya', dismissal_date: '2026-10-31' },
    ];
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-10')).toBe('dept-liniya');
    expect(resolveDeptOnDate(source, 1, '2026-05-10')).toBe('dept-su10');
    // Позже всех увольнений — последнее.
    expect(resolveDeptOnDate(source, 1, '2026-11-05')).toBe('dept-liniya');
  });

  it('нет ничего — null, компания «Без компании»', async () => {
    const source = await load();
    expect(resolveDeptOnDate(source, 1, '2026-09-05')).toBeNull();
    expect(resolveCompanyOnDate(source, 1, '2026-09-05')).toEqual(NO_COMPANY);
  });
});

describe('resolveCompanyOnDate', () => {
  it('отдел → компания-узел; одноимённые компании различаются ключом', async () => {
    state.assignments = [
      assignment('a1', 1, 'dept-su10-b', '2026-01-01', '2026-09-14'),
      assignment('a2', 1, 'dept-twin', '2026-09-15', null),
    ];
    const source = await load();
    expect(resolveCompanyOnDate(source, 1, '2026-09-01')).toEqual({ key: 'local:company-su10', name: 'СУ-10' });
    expect(resolveCompanyOnDate(source, 1, '2026-09-20')).toEqual({ key: 'local:company-twin', name: 'СУ-10' });
  });

  it('отдел вне корня «Объект» — «Без компании»', async () => {
    state.assignments = [assignment('a1', 1, 'dept-unknown', '2026-01-01', null)];
    const source = await load();
    expect(resolveCompanyOnDate(source, 1, '2026-09-01')).toEqual(NO_COMPANY);
  });
});
