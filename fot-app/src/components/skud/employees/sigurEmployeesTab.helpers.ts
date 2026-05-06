/**
 * Утилиты и типы вкладки Sigur-сотрудников.
 *
 * Извлечено из SigurEmployeesTab.tsx (Волна 3 декомпозиции).
 * Pure-функции по дереву отделов + типы dialog-state — без React,
 * легко тестируются и переиспользуются (DepartmentTreeNode и др.).
 */
import type { SigurDepartmentNode, SigurEmployeeCardAccessStatus, SigurEmployeeSummary } from '../../../types';

// ─── Constants ─────────────────────────────────────────────────────────────

export const EMPLOYEE_DRAG_TYPE = 'application/x-fot-sigur-employees';
export const EMPLOYEES_PAGE_SIZE = 100;

export const DEPT_PANEL_WIDTH_KEY = 'sigur-dept-panel-width';
export const DEPT_PANEL_MIN_WIDTH = 200;
export const DEPT_PANEL_MAX_WIDTH = 640;
export const DEPT_PANEL_DEFAULT_WIDTH = 288;

export const readInitialDeptPanelWidth = (): number => {
  if (typeof window === 'undefined') return DEPT_PANEL_DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(DEPT_PANEL_WIDTH_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEPT_PANEL_DEFAULT_WIDTH;
  return Math.min(DEPT_PANEL_MAX_WIDTH, Math.max(DEPT_PANEL_MIN_WIDTH, parsed));
};

// ─── Dialog state types ────────────────────────────────────────────────────

export type EmployeeStatusFilter = 'all' | 'active' | 'blocked';

export type DepartmentDialogState =
  | { mode: 'create'; name: string; parentId: number | null }
  | { mode: 'rename'; name: string; departmentId: number }
  | { mode: 'move'; departmentIds: number[]; parentId: number | null }
  | null;

export type DeleteDepartmentsDialogState = {
  departmentIds: number[];
  names: string[];
  totalChildDepts: number;
  directEmployees: number;
  totalEmployees: number;
  hasChildren: boolean;
} | null;

export type EmployeeDialogState = {
  mode: 'create' | 'edit';
  sigurEmployeeId: number | null;
  name: string;
  departmentId: string;
  positionId: string;
  tabId: string;
  description: string;
  blocked: boolean;
} | null;

export type EmployeeMoveDialogState = {
  employeeIds: number[];
  departmentId: string;
} | null;

export type DepartmentContextMenuState = {
  x: number;
  y: number;
  selection: number[];
} | null;

// ─── Status presentation ───────────────────────────────────────────────────

export const formatStatusDate = (value: string | null): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU');
};

export const getEmployeeStatusPresentation = (
  employee: SigurEmployeeSummary,
  cardStatus?: SigurEmployeeCardAccessStatus,
  loading = false,
): { text: string; tone: 'ok' | 'danger' | 'muted' | 'warn' } => {
  if (employee.blocked) {
    return { text: 'Заблокирован', tone: 'danger' };
  }

  if (!cardStatus) {
    return { text: loading ? 'Проверяем...' : 'Нет данных', tone: 'muted' };
  }

  if (cardStatus.state === 'active') {
    return {
      text: cardStatus.expirationDate ? `До ${formatStatusDate(cardStatus.expirationDate)}` : 'Активен',
      tone: 'ok',
    };
  }

  if (cardStatus.state === 'expired') {
    return {
      text: cardStatus.expirationDate ? `Истек ${formatStatusDate(cardStatus.expirationDate)}` : 'Истек',
      tone: 'warn',
    };
  }

  if (cardStatus.state === 'no_expiration') {
    return { text: 'Без срока', tone: 'ok' };
  }

  if (cardStatus.state === 'no_card') {
    return { text: 'Нет пропуска', tone: 'muted' };
  }

  return { text: 'Нет данных', tone: 'muted' };
};

// ─── Department tree helpers ───────────────────────────────────────────────

export const flattenDepartments = (
  nodes: SigurDepartmentNode[],
  level = 0,
): Array<{ id: number; name: string; level: number; parentId: number | null }> => (
  nodes.flatMap(node => [
    { id: node.id, name: node.name, level, parentId: node.parentId },
    ...flattenDepartments(node.children || [], level + 1),
  ])
);

export const buildDepartmentNodeMap = (nodes: SigurDepartmentNode[]): Map<number, SigurDepartmentNode> => {
  const map = new Map<number, SigurDepartmentNode>();
  const walk = (items: SigurDepartmentNode[]) => {
    items.forEach(item => {
      map.set(item.id, item);
      walk(item.children || []);
    });
  };
  walk(nodes);
  return map;
};

export const findDepartmentById = (nodes: SigurDepartmentNode[], id: number | null): SigurDepartmentNode | null => {
  if (id == null) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findDepartmentById(node.children || [], id);
    if (child) return child;
  }
  return null;
};

export const collectDepartmentIds = (node: SigurDepartmentNode | null): Set<number> => {
  if (!node) return new Set();
  const ids = new Set<number>();
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    ids.add(current.id);
    for (const child of current.children || []) stack.push(child);
  }
  return ids;
};

export const getMatchingDepartmentIds = (nodes: SigurDepartmentNode[], query: string): Set<number> | null => {
  const trimmed = query.trim().toLocaleLowerCase('ru');
  if (!trimmed) return null;

  const visible = new Set<number>();

  const walk = (node: SigurDepartmentNode): boolean => {
    const childMatched = (node.children || []).some(walk);
    const selfMatched = node.name.toLocaleLowerCase('ru').includes(trimmed);
    if (selfMatched || childMatched) {
      visible.add(node.id);
      return true;
    }
    return false;
  };

  nodes.forEach(walk);
  return visible;
};

export const collectExpandedSearchIds = (
  nodes: SigurDepartmentNode[],
  visibleIds: Set<number> | null,
  target: Set<number> = new Set(),
): Set<number> => {
  if (!visibleIds) return target;

  const walk = (node: SigurDepartmentNode): boolean => {
    const visibleChildren = (node.children || []).filter(child => walk(child));
    const selfVisible = visibleIds.has(node.id);
    if (selfVisible && visibleChildren.length > 0) {
      target.add(node.id);
    }
    return selfVisible;
  };

  nodes.forEach(walk);
  return target;
};

export const getRootExpandedIds = (nodes: SigurDepartmentNode[]): Set<number> => (
  new Set(
    nodes
      .filter(node => (node.children || []).length > 0)
      .map(node => node.id),
  )
);

export const getDepartmentPathIds = (
  nodes: SigurDepartmentNode[],
  targetId: number,
): number[] => {
  for (const node of nodes) {
    if (node.id === targetId) return [node.id];
    const childPath = getDepartmentPathIds(node.children || [], targetId);
    if (childPath.length > 0) return [node.id, ...childPath];
  }
  return [];
};

export const getContextMenuPosition = (contextMenu: NonNullable<DepartmentContextMenuState>): { left: number; top: number } => {
  if (typeof window === 'undefined') return { left: contextMenu.x, top: contextMenu.y };
  return {
    left: Math.min(contextMenu.x, window.innerWidth - 240),
    top: Math.min(contextMenu.y, window.innerHeight - 220),
  };
};
