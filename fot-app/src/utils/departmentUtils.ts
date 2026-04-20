import type { OrgDepartmentNode } from '../types/organization';

// Единый источник истины для сортировки отделов на фронтенде.
export interface IDepartmentOption {
  id: string | number;
  name: string;
}

export interface IFlatDepartmentOption extends IDepartmentOption {
  id: string;
  level: number;
  hasChildren: boolean;
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

    result.push({ id: node.id, name: node.name, level, hasChildren: (node.children?.length ?? 0) > 0 });
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
