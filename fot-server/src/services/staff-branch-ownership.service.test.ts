import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Отделы «Управления кадрами» и владелец дня: кандидаты месяца без подрядчиков и «Уволенных», самый глубокий
 * отдел, блокирующие узлы внутри поддерева кандидата.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  contractorRoot: vi.fn(),
  archive: vi.fn(),
  memberships: vi.fn(),
  tree: [] as Array<{ id: string; parent_id: string | null; name: string; sigur_department_id: null }>,
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));
vi.mock('../config/contractor.js', () => ({ getContractorRootId: h.contractorRoot }));
vi.mock('./employee-archive-department.service.js', () => ({ getKnownArchiveDepartment: h.archive }));
vi.mock('./skud-shared.service.js', () => ({
  getAllDepartmentsTree: vi.fn(async () => h.tree),
  collectDeptIds: vi.fn(async (rootId: string) => {
    const ids = [rootId];
    for (let i = 0; i < ids.length; i += 1) {
      for (const row of h.tree) if (row.parent_id === ids[i]) ids.push(row.id);
    }
    return ids;
  }),
}));
vi.mock('./timesheet-department-assignments.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./timesheet-department-assignments.service.js')>()),
  listEmployeeMembershipsForDepartmentsPeriod: h.memberships,
}));

const {
  describeBranches,
  listBranchCandidateIds,
  loadBranchOwnership,
} = await import('./staff-branch-ownership.service.js');

const node = (id: string, parent: string | null, name: string) => ({ id, parent_id: parent, name, sigur_department_id: null });

// Объект → СУ-10 → Строительство → ЛИНИЯ / бр.Иванов; Объект → СМ; Объект → Подрядные → ООО Ромашка; Объект → Уволенные.
// Участок (кандидат) с подрядчиком внутри: Участок → бр.Петров, Участок → Подрядчик участка.
const TREE = [
  node('obj', null, 'Объект'),
  node('su10', 'obj', '(СУ-10) ООО СУ-10'),
  node('stroy', 'su10', 'Департамент строительства'),
  node('line', 'stroy', 'ЛИНИЯ'),
  node('brig', 'stroy', 'бр.Иванов'),
  node('sm', 'obj', '(СМ) Служба Механизации'),
  node('contr', 'obj', 'Подрядные организации'),
  node('c1', 'contr', 'ООО Ромашка'),
  node('fired', 'obj', 'Уволенные'),
  node('site', 'su10', 'Участок'),
  node('brig2', 'site', 'бр.Петров'),
  node('cx', 'site', 'Подрядчик участка'),
];

interface IMember { employee_id: number; transferred_out_date?: string | null; joined_date?: string | null; joined_via_transfer?: boolean }

const givenMembers = (byRoot: Record<string, IMember[]>): void => {
  h.memberships.mockImplementation(async (roots: string[]) => new Map(roots.map(root => [root, (byRoot[root] ?? []).map(member => ({
    transferred_out_date: null, joined_date: null, joined_via_transfer: false, ...member,
  }))])));
};

beforeEach(() => {
  h.tree = TREE;
  h.query.mockReset();
  h.contractorRoot.mockReset().mockResolvedValue('contr');
  h.archive.mockReset().mockResolvedValue({ id: 'fired', name: 'Уволенные' });
  h.memberships.mockReset();
});

describe('listBranchCandidateIds', () => {
  it('три источника состава табеля, только отделы и бригады; подрядчики и «Уволенные» отброшены', async () => {
    h.query.mockResolvedValue([{ id: 'line' }, { id: 'brig' }, { id: 'c1' }, { id: 'fired' }, { id: 'sm' }]);

    expect(await listBranchCandidateIds('2026-11')).toEqual(['line', 'brig', 'sm']);

    const [sql, params] = h.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('FROM employee_assignments');
    expect(String(sql)).toContain('FROM employees WHERE org_department_id IS NOT NULL');
    expect(String(sql)).toContain('FROM employee_dismissal_events');
    expect(String(sql)).toContain("d.kind IN ('department', 'brigade')");
    expect(params).toEqual(['2026-11-01', '2026-11-30']);
  });

  it('корня подрядчиков нет, архив не определился — ничего не исключаем, экран не падает', async () => {
    h.contractorRoot.mockResolvedValue(null);
    h.archive.mockRejectedValue(new Error('sigur down'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.query.mockResolvedValue([{ id: 'c1' }, { id: 'fired' }]);

    expect(await listBranchCandidateIds('2026-11')).toEqual(['c1', 'fired']);
  });

  it('неверный месяц — пусто без запросов', async () => {
    expect(await listBranchCandidateIds('2026-13')).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('loadBranchOwnership', () => {
  it('родитель и бригада: день достаётся бригаде, а не отделу-родителю', async () => {
    // Состав родителя — всё поддерево, поэтому человек бригады есть и у него.
    givenMembers({ stroy: [{ employee_id: 1 }], brig: [{ employee_id: 1 }] });

    const ownership = await loadBranchOwnership('2026-11', ['stroy', 'brig']);

    expect(ownership.ownerOf(1, '2026-11-07')).toBe('brig');
    expect(ownership.employeeIds).toEqual([1]);
  });

  it('владелец не зависит от порядка кандидатов', async () => {
    givenMembers({ stroy: [{ employee_id: 1 }], brig: [{ employee_id: 1 }] });
    expect((await loadBranchOwnership('2026-11', ['brig', 'stroy'])).ownerOf(1, '2026-11-07')).toBe('brig');
  });

  it('перевод между отделами: окна не затирают друг друга, день — по окну', async () => {
    givenMembers({
      line: [{ employee_id: 1, transferred_out_date: '2026-11-16' }],
      brig: [{ employee_id: 1, joined_date: '2026-11-16', joined_via_transfer: true }],
    });

    const ownership = await loadBranchOwnership('2026-11', ['line', 'brig']);

    expect(ownership.ownerOf(1, '2026-11-08')).toBe('line');
    expect(ownership.ownerOf(1, '2026-11-22')).toBe('brig');
  });

  it('сотрудник вне кандидатов — без владельца', async () => {
    givenMembers({ line: [{ employee_id: 1 }] });
    expect((await loadBranchOwnership('2026-11', ['line'])).ownerOf(999, '2026-11-08')).toBeNull();
  });

  it('уволенный виден в месяце увольнения: окна грузятся с firedInDismissalMonth', async () => {
    givenMembers({ line: [{ employee_id: 2, transferred_out_date: '2026-11-21' }] });

    const ownership = await loadBranchOwnership('2026-11', ['line']);

    expect(ownership.ownerOf(2, '2026-11-15')).toBe('line');
    expect(ownership.ownerOf(2, '2026-11-22')).toBeNull();
    expect(h.memberships).toHaveBeenCalledWith(['line'], '2026-11-01', '2026-11-30', { firedInDismissalMonth: true });
  });

  it('подрядчик внутри поддерева кандидата — блокирующий узел: его день не переезжает в предка', async () => {
    h.contractorRoot.mockResolvedValue('cx');
    givenMembers({ site: [{ employee_id: 5 }], cx: [{ employee_id: 5 }] });

    const ownership = await loadBranchOwnership('2026-11', ['site']);

    expect(h.memberships.mock.calls[0]?.[0]).toEqual(['site', 'cx']);
    expect(ownership.ownerOf(5, '2026-11-08')).toBeNull();
  });

  it('обычный отдел → подрядчик в середине месяца: дни в отделе остаются, у подрядчика отброшены', async () => {
    h.contractorRoot.mockResolvedValue('cx');
    givenMembers({
      site: [{ employee_id: 7 }],
      brig2: [{ employee_id: 7, transferred_out_date: '2026-11-16' }],
      cx: [{ employee_id: 7, joined_date: '2026-11-16', joined_via_transfer: true }],
    });

    const ownership = await loadBranchOwnership('2026-11', ['site', 'brig2']);

    expect(ownership.employeeIds).toEqual([7]);
    expect(ownership.ownerOf(7, '2026-11-08')).toBe('brig2');
    expect(ownership.ownerOf(7, '2026-11-22')).toBeNull();
  });

  it('подрядчик → обычный отдел в середине месяца: дни у подрядчика отброшены, в отделе остаются', async () => {
    h.contractorRoot.mockResolvedValue('cx');
    givenMembers({
      site: [{ employee_id: 8 }],
      brig2: [{ employee_id: 8, joined_date: '2026-11-16', joined_via_transfer: true }],
      cx: [{ employee_id: 8, transferred_out_date: '2026-11-16' }],
    });

    const ownership = await loadBranchOwnership('2026-11', ['site', 'brig2']);

    expect(ownership.employeeIds).toEqual([8]);
    expect(ownership.ownerOf(8, '2026-11-08')).toBeNull();
    expect(ownership.ownerOf(8, '2026-11-22')).toBe('brig2');
  });

  it('люди одного лишь блокирующего узла в проверку не идут', async () => {
    h.contractorRoot.mockResolvedValue('cx');
    givenMembers({ site: [], cx: [{ employee_id: 9 }] });
    expect((await loadBranchOwnership('2026-11', ['site'])).employeeIds).toEqual([]);
  });

  it('подрядчики вне поддерева кандидатов не грузятся вовсе', async () => {
    givenMembers({ line: [{ employee_id: 1 }] });
    await loadBranchOwnership('2026-11', ['line']);
    expect(h.memberships.mock.calls[0]?.[0]).toEqual(['line']);
  });

  it('без кандидатов — пусто, без запросов', async () => {
    const ownership = await loadBranchOwnership('2026-11', []);
    expect(ownership.employeeIds).toEqual([]);
    expect(h.memberships).not.toHaveBeenCalled();
  });
});

describe('describeBranches', () => {
  it('названия из дерева, порядок — по пути: СМ раньше СУ-10, внутри — по дереву', async () => {
    expect(await describeBranches(['brig', 'sm', 'line', 'line'])).toEqual([
      { id: 'sm', name: '(СМ) Служба Механизации' },
      { id: 'brig', name: 'бр.Иванов' },
      { id: 'line', name: 'ЛИНИЯ' },
    ]);
  });
});
