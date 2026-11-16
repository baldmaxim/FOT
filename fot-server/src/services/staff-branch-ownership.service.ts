import { query } from '../config/postgres.js';
import { getContractorRootId } from '../config/contractor.js';
import { collectDeptIds, getAllDepartmentsTree, type IDeptTreeRow } from './skud-shared.service.js';
import {
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  listEmployeeMembershipsForDepartmentsPeriod,
  resolveTimesheetPeriodRange,
  type IMembershipWindow,
} from './timesheet-department-assignments.service.js';

/**
 * Отделы «Управления кадрами» за месяц и владелец дня — для вкладок «Выходные» и «Корректировки».
 *
 * Кандидаты — все отделы и бригады, где кто-то числился в месяце: те же три источника, что у состава табеля
 * (назначения, снимок employees.org_department_id, уволенные из отдела). Без подрядчиков и без «Уволенных».
 *
 * День сотрудника принадлежит самому глубокому отделу, в окне которого он в этот день: состав табеля отдела берёт
 * всё поддерево, и без этого правила день бригады попал бы ещё и в отдел-родитель. Владелец определяется по ВСЕМ
 * кандидатам месяца, а охват пользователя применяется уже к результату: иначе при доступе к родителю без ребёнка
 * день ребёнка переехал бы в родителя.
 */

export interface IBranchOwnership {
  /** Люди кандидатов (без людей блокирующих узлов). */
  employeeIds: number[];
  /** Владелец дня: кандидат или null (ни в одном кандидате, либо глубже всех — подрядчик/«Уволенные»). */
  ownerOf: (employeeId: number, date: string) => string | null;
}

interface ITreeIndex {
  parentOf: Map<string, string | null>;
  nameOf: Map<string, string>;
}

const buildTreeIndex = (rows: readonly IDeptTreeRow[]): ITreeIndex => ({
  parentOf: new Map(rows.map(row => [row.id, row.parent_id ?? null])),
  nameOf: new Map(rows.map(row => [row.id, row.name ?? ''])),
});

/** Предки узла снизу вверх, без самого узла. Защита от цикла в дереве. */
const ancestorsOf = (index: ITreeIndex, id: string): string[] => {
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let current = index.parentOf.get(id) ?? null;
  while (current && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = index.parentOf.get(current) ?? null;
  }
  return result;
};

/** Отдел «Уволенные». Не нашёлся или ошибка — null: тогда исключать нечего, экран не падает. */
const resolveArchiveDepartmentId = async (): Promise<string | null> => {
  try {
    // Динамически: сервис архива тянет Sigur-модули (как в resolvePayrollArchiveDepartmentId).
    const { getKnownArchiveDepartment } = await import('./employee-archive-department.service.js');
    return (await getKnownArchiveDepartment())?.id ?? null;
  } catch (error) {
    console.warn('[staff-branches] отдел «Уволенные» не определён:', error);
    return null;
  }
};

/** Узлы вне вкладок: всё поддерево подрядчиков и «Уволенные». Корня или архива нет — без них. */
export const resolveExcludedDepartmentIds = async (): Promise<Set<string>> => {
  const [contractorRootId, archiveId] = await Promise.all([getContractorRootId(), resolveArchiveDepartmentId()]);
  const excluded = new Set<string>();
  for (const rootId of [contractorRootId, archiveId]) {
    if (!rootId) continue;
    for (const id of await collectDeptIds(rootId)) excluded.add(id);
  }
  return excluded;
};

/** Кандидаты месяца YYYY-MM: отделы и бригады, где кто-то числился. Неверный месяц — пусто. */
export const listBranchCandidateIds = async (month: string): Promise<string[]> => {
  const range = resolveTimesheetPeriodRange(month);
  if (!range) return [];
  const [rows, excluded] = await Promise.all([
    query<{ id: string }>(
      `SELECT d.id
         FROM org_departments d
        WHERE d.kind IN ('department', 'brigade')
          AND d.id IN (
                SELECT org_department_id FROM employee_assignments
                 WHERE org_department_id IS NOT NULL
                   AND effective_from <= $2::date
                   AND (effective_to IS NULL OR effective_to >= $1::date)
                UNION
                SELECT org_department_id FROM employees WHERE org_department_id IS NOT NULL
                UNION
                SELECT from_department_id FROM employee_dismissal_events
                 WHERE from_department_id IS NOT NULL AND cancelled = false AND dismissal_date >= $1::date
              )`,
      [range.startDate, range.endDate],
    ),
    resolveExcludedDepartmentIds(),
  ]);
  return rows.map(row => String(row.id)).filter(id => !excluded.has(id));
};

/**
 * Блокирующие узлы: верхние исключённые узлы внутри поддерева какого-либо кандидата. Пакетный загрузчик раскрывает
 * поддерево каждого корня, и без них человек подрядчика попал бы в предка-кандидата. Обычно таких нет.
 */
const findBlockingRoots = (
  index: ITreeIndex,
  candidates: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): string[] => [...excluded].filter((id) => {
  const parent = index.parentOf.get(id) ?? null;
  if (parent && excluded.has(parent)) return false;
  return ancestorsOf(index, id).some(ancestor => candidates.has(ancestor));
});

/**
 * Владение днём за месяц по кандидатам. Окна — как у сетки табеля: уволенный виден в месяце увольнения до его даты,
 * нижняя граница окна — только при настоящем переводе.
 */
export const loadBranchOwnership = async (
  month: string,
  candidateIds: readonly string[],
): Promise<IBranchOwnership> => {
  const range = resolveTimesheetPeriodRange(month);
  if (!range || candidateIds.length === 0) return { employeeIds: [], ownerOf: () => null };

  const [tree, excluded] = await Promise.all([getAllDepartmentsTree(), resolveExcludedDepartmentIds()]);
  const index = buildTreeIndex(tree);
  const candidates = new Set(candidateIds);
  const blocking = new Set(findBlockingRoots(index, candidates, excluded));

  const memberships = await listEmployeeMembershipsForDepartmentsPeriod(
    [...candidates, ...blocking], range.startDate, range.endDate, { firedInDismissalMonth: true },
  );
  const roots = [...memberships].map(([rootId, list]) => ({
    rootId,
    depth: ancestorsOf(index, rootId).length,
    windows: buildMembershipWindowMap(list),
  }));
  // Глубже — раньше, при равной глубине — по id: владелец не зависит от порядка кандидатов.
  roots.sort((a, b) => b.depth - a.depth || a.rootId.localeCompare(b.rootId));

  // В проверку дня — только люди кандидатов: переведённый в подрядчики (или из них) в середине месяца остаётся,
  // его дни у подрядчика отбросит ownerOf.
  const employeeIds = [...new Set(roots
    .filter(root => !blocking.has(root.rootId))
    .flatMap(root => [...root.windows.keys()]))];

  const ownerOf = (employeeId: number, date: string): string | null => {
    const found = roots.find(({ windows }) => {
      const window: IMembershipWindow | undefined = windows.get(employeeId);
      // Без окна isWithinMembershipWindow вернул бы true: сотрудник другого отдела, а не «без ограничений».
      return window !== undefined && isWithinMembershipWindow(window, date, 'viaTransferOnly');
    });
    if (!found || blocking.has(found.rootId)) return null;
    return found.rootId;
  };

  return { employeeIds, ownerOf };
};

export interface IBranchPathNode {
  id: string;
  name: string;
}

export interface IDescribedBranch {
  id: string;
  name: string;
  /** Предки от корня до родителя — для списка отделов деревом, как в «Текущих сотрудниках». */
  path: IBranchPathNode[];
}

/** Названия, предки и порядок по пути в дереве (компания → отдел → бригада). */
export const describeBranches = async (branchIds: readonly string[]): Promise<IDescribedBranch[]> => {
  const index = buildTreeIndex(await getAllDepartmentsTree());
  return [...new Set(branchIds)]
    .map((id) => {
      const path = ancestorsOf(index, id).reverse().map(nodeId => ({ id: nodeId, name: index.nameOf.get(nodeId) ?? '' }));
      const name = index.nameOf.get(id) ?? '';
      return { id, name, path, sortKey: [...path.map(node => node.name), name].join(' / ') };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'ru') || a.id.localeCompare(b.id))
    .map(({ id, name, path }) => ({ id, name, path }));
};
