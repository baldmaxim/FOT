import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Выходные» кадров: поверх правил дня (weekend-missing-days) и владельца дня (staff-branch-ownership) — раскладка
 * по отделам, охват после владения, строки и порядок.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  missing: vi.fn(),
  ownership: vi.fn(),
  describe: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));
vi.mock('./weekend-missing-days.service.js', () => ({ listWeekendMissingDays: h.missing }));
vi.mock('./staff-branch-ownership.service.js', () => ({
  loadBranchOwnership: h.ownership,
  describeBranches: h.describe,
}));

const { listWeekendsByBranch } = await import('./staff-weekends.service.js');

const LINE = 'line';
const GENERAL = 'general';
const STROY = 'stroy';
const NAMES: Record<string, string> = { [LINE]: 'ЛИНИЯ', [GENERAL]: 'ЛИНИЯ-Общестрой', [STROY]: 'Департамент строительства' };

const day = (employeeId: number, date: string) => ({ employee_id: employeeId, date, without_hours: false });

/** Владелец дня: «сотрудник|дата» → отдел; по умолчанию — LINE. */
const givenOwnership = (employeeIds: number[], owners: Record<string, string | null> = {}): void => {
  h.ownership.mockResolvedValue({
    employeeIds,
    ownerOf: (employeeId: number, date: string) => (`${employeeId}|${date}` in owners ? owners[`${employeeId}|${date}`] : LINE),
  });
};

const givenEmployees = (employees: Array<{ id: number; full_name: string; position?: string | null }>): void => {
  h.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM employees')) return employees.map(employee => ({ position: null, ...employee }));
    throw new Error(`неожиданный запрос: ${sql}`);
  });
};

beforeEach(() => {
  h.query.mockReset();
  h.missing.mockReset().mockResolvedValue([]);
  h.ownership.mockReset();
  h.describe.mockReset().mockImplementation(async (ids: string[]) => ids.map(id => ({ id, name: NAMES[id] ?? id })));
});

const scope = (visible: string[], ownership: string[] = [LINE, GENERAL, STROY]) => ({
  ownershipBranchIds: ownership,
  visibleBranchIds: visible,
});

describe('listWeekendsByBranch', () => {
  it('строки по владельцу дня, дни по порядку без повторов, ФИО и должность из карточки', async () => {
    givenOwnership([1]);
    h.missing.mockResolvedValue([day(1, '2026-11-08'), day(1, '2026-11-01'), day(1, '2026-11-08')]);
    givenEmployees([{ id: 1, full_name: 'Агарков Д. Н.', position: 'Мастер' }]);

    expect(await listWeekendsByBranch('2026-11', scope([LINE]))).toEqual([{
      id: LINE,
      name: 'ЛИНИЯ',
      rows: [{ employee_id: 1, full_name: 'Агарков Д. Н.', position: 'Мастер', days: ['2026-11-01', '2026-11-08'] }],
    }]);
    expect(h.ownership).toHaveBeenCalledWith('2026-11', [LINE, GENERAL, STROY]);
    expect(h.missing).toHaveBeenCalledWith([1], expect.objectContaining({ startDate: '2026-11-01', endDate: '2026-11-30' }));
  });

  it('владелец считается по всем кандидатам, охват — после: день ребёнка не переезжает в доступного родителя', async () => {
    givenOwnership([1], { '1|2026-11-08': LINE });
    h.missing.mockResolvedValue([day(1, '2026-11-08')]);
    givenEmployees([{ id: 1, full_name: 'Иванов' }]);

    const branches = await listWeekendsByBranch('2026-11', scope([STROY]));

    expect(branches).toEqual([{ id: STROY, name: 'Департамент строительства', rows: [] }]);
    expect(h.ownership).toHaveBeenCalledWith('2026-11', [LINE, GENERAL, STROY]);
  });

  it('день без владельца (подрядчик, вне кандидатов) не попадает никуда', async () => {
    givenOwnership([1], { '1|2026-11-22': null });
    h.missing.mockResolvedValue([day(1, '2026-11-08'), day(1, '2026-11-22')]);
    givenEmployees([{ id: 1, full_name: 'Иванов' }]);

    const [line] = await listWeekendsByBranch('2026-11', scope([LINE]));

    expect(line?.rows[0]?.days).toEqual(['2026-11-08']);
  });

  it('перевод внутри месяца: строка в каждом отделе со своими днями, проверка одна на всех', async () => {
    givenOwnership([1], { '1|2026-11-08': LINE, '1|2026-11-22': GENERAL });
    h.missing.mockResolvedValue([day(1, '2026-11-08'), day(1, '2026-11-22')]);
    givenEmployees([{ id: 1, full_name: 'Иванов' }]);

    const [line, general] = await listWeekendsByBranch('2026-11', scope([LINE, GENERAL]));

    expect(line?.rows[0]?.days).toEqual(['2026-11-08']);
    expect(general?.rows[0]?.days).toEqual(['2026-11-22']);
    expect(h.missing).toHaveBeenCalledTimes(1);
  });

  it('видимые отделы приходят все, в том числе без людей, в порядке дерева', async () => {
    givenOwnership([]);
    h.describe.mockResolvedValue([{ id: GENERAL, name: 'ЛИНИЯ-Общестрой' }, { id: LINE, name: 'ЛИНИЯ' }]);

    expect(await listWeekendsByBranch('2026-11', scope([LINE, GENERAL]))).toEqual([
      { id: GENERAL, name: 'ЛИНИЯ-Общестрой', rows: [] },
      { id: LINE, name: 'ЛИНИЯ', rows: [] },
    ]);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('часов СКУД в ответе нет: в сводке не вычтен обед, часы показывает табель', async () => {
    givenOwnership([1]);
    h.missing.mockResolvedValue([day(1, '2026-11-08')]);
    givenEmployees([{ id: 1, full_name: 'Иванов' }]);

    const [branch] = await listWeekendsByBranch('2026-11', scope([LINE]));

    expect(branch?.rows[0]).not.toHaveProperty('total_minutes');
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes('skud_daily_summary'))).toBe(false);
  });

  it('порядок внутри отдела — по ФИО', async () => {
    givenOwnership([1, 2]);
    h.missing.mockResolvedValue([day(1, '2026-11-08'), day(2, '2026-11-08')]);
    givenEmployees([{ id: 1, full_name: 'Яковлев' }, { id: 2, full_name: 'Абдуллаев' }]);

    const [branch] = await listWeekendsByBranch('2026-11', scope([LINE]));

    expect(branch?.rows.map(row => row.full_name)).toEqual(['Абдуллаев', 'Яковлев']);
  });

  it('вне охвата или неверный месяц — пусто без запросов', async () => {
    expect(await listWeekendsByBranch('2026-11', scope([]))).toEqual([]);
    expect(await listWeekendsByBranch('2026-13', scope([LINE]))).toEqual([]);
    expect(h.ownership).not.toHaveBeenCalled();
    expect(h.missing).not.toHaveBeenCalled();
  });
});
