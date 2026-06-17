import type { OrgDepartmentKind, OrgDepartmentNode } from '../types/organization';

// Единый источник истины для сортировки отделов на фронтенде.
export interface IDepartmentOption {
  id: string | number;
  name: string;
}

export interface IFlatDepartmentOption extends IDepartmentOption {
  id: string;
  level: number;
  hasChildren: boolean;
  kind: OrgDepartmentKind;
  // true — узел в scope пользователя (selectable в дропдауне).
  // false — узел оставлен только как контейнер-предок (рисуется серым заголовком).
  inScope: boolean;
}

const departmentNameCollator = new Intl.Collator('ru', {
  sensitivity: 'base',
  ignorePunctuation: true,
  numeric: true,
});

const ROOT_FOLDER_NAMES = new Set([
  'объект',
]);

const isHiddenRootFolderForLists = (node: OrgDepartmentNode, level: number): boolean => {
  if (level !== 0 || node.parent_id !== null) return false;

  const normalizedName = node.name.trim().toLowerCase();
  if (ROOT_FOLDER_NAMES.has(normalizedName)) return true;

  return /^структура\s+\d{4}$/u.test(normalizedName);
};

export const getDepartmentTypeMarker = (name: string): string | null => {
  const trimmed = name.trim();
  const leadingMatch = trimmed.match(/^\(([^()]+)\)\s*/u);
  if (leadingMatch) return leadingMatch[1].trim().toUpperCase();
  return null;
};

const getDepartmentBaseName = (name: string): string => (
  name
    .trim()
    .replace(/^\(([^()]+)\)\s*/u, '')
    .trim()
);

export const compareDepartmentNames = (aName: string, bName: string): number => {
  const aType = getDepartmentTypeMarker(aName);
  const bType = getDepartmentTypeMarker(bName);

  if (aType && !bType) return -1;
  if (!aType && bType) return 1;

  if (aType && bType) {
    const typeDiff = departmentNameCollator.compare(aType, bType);
    if (typeDiff !== 0) return typeDiff;
    const baseNameDiff = departmentNameCollator.compare(
      getDepartmentBaseName(aName),
      getDepartmentBaseName(bName),
    );
    if (baseNameDiff !== 0) return baseNameDiff;
  }

  return departmentNameCollator.compare(aName.trim(), bName.trim());
};

export const sortDepartmentOptions = <T extends IDepartmentOption>(departments: T[]): T[] => (
  [...departments].sort((a, b) => {
    const nameDiff = compareDepartmentNames(a.name, b.name);
    if (nameDiff !== 0) return nameDiff;
    return String(a.id).localeCompare(String(b.id), 'ru');
  })
);

export const sortDepartmentTree = (nodes: OrgDepartmentNode[]): OrgDepartmentNode[] => (
  [...nodes]
    .sort((a, b) => {
      const nameDiff = compareDepartmentNames(a.name, b.name);
      if (nameDiff !== 0) return nameDiff;
      return a.id.localeCompare(b.id, 'ru');
    })
    .map(node => ({
      ...node,
      children: sortDepartmentTree(node.children ?? []),
    }))
);

export const flattenDepartmentTree = (nodes: OrgDepartmentNode[], level = 0): IFlatDepartmentOption[] => {
  const result: IFlatDepartmentOption[] = [];
  for (const node of nodes) {
    if (isHiddenRootFolderForLists(node, level)) {
      if (node.children?.length) {
        result.push(...flattenDepartmentTree(node.children, level));
      }
      continue;
    }

    result.push({
      id: node.id,
      name: node.name,
      level,
      hasChildren: (node.children?.length ?? 0) > 0,
      kind: node.kind,
      inScope: node.in_scope ?? true,
    });
    if (node.children?.length) {
      result.push(...flattenDepartmentTree(node.children, level + 1));
    }
  }
  return result;
};

export const getTreeFlatDepartments = (nodes: OrgDepartmentNode[]): IFlatDepartmentOption[] =>
  flattenDepartmentTree(sortDepartmentTree(nodes));

export const getSortedDepartmentOptions = (nodes: OrgDepartmentNode[]): IDepartmentOption[] => (
  getSortedFlatDepartments(nodes).map(({ id, name }) => ({ id, name }))
);

export const getSortedFlatDepartments = (nodes: OrgDepartmentNode[]): IFlatDepartmentOption[] => (
  sortDepartmentOptions(flattenDepartmentTree(nodes))
);

export const collectDescendantIds = (
  nodes: OrgDepartmentNode[],
  rootIds: Set<string>,
): Set<string> => {
  const out = new Set<string>();
  const walk = (node: OrgDepartmentNode, inside: boolean): void => {
    const here = inside || rootIds.has(node.id);
    if (here) out.add(node.id);
    node.children?.forEach(child => walk(child, here));
  };
  nodes.forEach(node => walk(node, false));
  return out;
};

export const filterDepartmentTreeByIds = (nodes: OrgDepartmentNode[], ids: Set<string>): OrgDepartmentNode[] =>
  nodes.reduce<OrgDepartmentNode[]>((acc, node) => {
    const children = filterDepartmentTreeByIds(node.children ?? [], ids);
    if (ids.has(node.id) || children.length > 0) {
      acc.push({ ...node, children });
    }
    return acc;
  }, []);

// Реальные видимые корни-компании: синтетический корень («Объект» /
// «Структура YYYY») сворачивается, его дети становятся корнями списка.
// Логика идентична flattenDepartmentTree (single source of truth — общая
// приватная isHiddenRootFolderForLists).
export const getVisibleRootNodes = (nodes: OrgDepartmentNode[]): OrgDepartmentNode[] => {
  const result: OrgDepartmentNode[] = [];
  for (const node of nodes) {
    if (isHiddenRootFolderForLists(node, 0)) {
      if (node.children?.length) result.push(...getVisibleRootNodes(node.children));
      continue;
    }
    result.push(node);
  }
  return result;
};

// Имя отдела по id в дереве (для подписи статичных веток, где нет плоского списка).
export const findDepartmentName = (nodes: OrgDepartmentNode[], id: string): string | null => {
  for (const node of nodes) {
    if (node.id === id) return node.name;
    const found = node.children?.length ? findDepartmentName(node.children, id) : null;
    if (found !== null) return found;
  }
  return null;
};

// ---- Папка компании «(СУ-10) ООО СУ-10» --------------------------------------

const SU10_NAME_RE = /су-?10/i;

// Узел компании «(СУ-10) ООО СУ-10»: не синтетический корень (kind!='object'),
// имя содержит «СУ-10». Ищем сверху вниз — компания встречается раньше своих
// вложенных отделов (напр. «Бухгалтерия СУ-10»), т.к. она прямой потомок корня.
export const findSu10CompanyNode = (nodes: OrgDepartmentNode[]): OrgDepartmentNode | null => {
  for (const node of nodes) {
    if (node.kind !== 'object' && SU10_NAME_RE.test(node.name)) return node;
    if (node.children?.length) {
      const found = findSu10CompanyNode(node.children);
      if (found) return found;
    }
  }
  return null;
};

// Поддерево компании СУ-10, где оставлены только узлы kind='department'
// (бригады/объекты убраны). Возвращает [companyNode] с отфильтрованными детьми —
// сам корень-компания остаётся кликабельным для каскадного выбора.
const keepDepartmentsOnly = (node: OrgDepartmentNode): OrgDepartmentNode => ({
  ...node,
  children: (node.children ?? [])
    .filter(c => c.kind === 'department')
    .map(keepDepartmentsOnly),
});

export const buildSu10DepartmentTree = (nodes: OrgDepartmentNode[]): OrgDepartmentNode[] => {
  const company = findSu10CompanyNode(nodes);
  return company ? [keepDepartmentsOnly(company)] : [];
};

// id всех потомков-отделов (kind='department') узла, без самого узла.
export const collectDepartmentIds = (node: OrgDepartmentNode): string[] => {
  const out: string[] = [];
  const walk = (n: OrgDepartmentNode): void => {
    n.children?.forEach(c => {
      if (c.kind === 'department') out.push(c.id);
      walk(c);
    });
  };
  walk(node);
  return out;
};

// Отделы (kind='department') внутри компании СУ-10 как {id, name}, отсортированы.
// Множество id совпадает с collectDepartmentIds(findSu10CompanyNode(...)).
export const collectSu10Departments = (nodes: OrgDepartmentNode[]): IDepartmentOption[] => {
  const company = findSu10CompanyNode(nodes);
  if (!company) return [];
  const out: IDepartmentOption[] = [];
  const walk = (n: OrgDepartmentNode): void => {
    n.children?.forEach(c => {
      if (c.kind === 'department') out.push({ id: c.id, name: c.name });
      walk(c);
    });
  };
  walk(company);
  return sortDepartmentOptions(out);
};

export const filterDepartmentTree = (nodes: OrgDepartmentNode[], query: string): OrgDepartmentNode[] => {
  const sortedNodes = sortDepartmentTree(nodes);
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) return sortedNodes;

  return sortedNodes.reduce<OrgDepartmentNode[]>((acc, node) => {
    const children = filterDepartmentTree(node.children ?? [], normalizedQuery);
    if (node.name.toLowerCase().includes(normalizedQuery) || children.length > 0) {
      acc.push({ ...node, children });
    }
    return acc;
  }, []);
};
