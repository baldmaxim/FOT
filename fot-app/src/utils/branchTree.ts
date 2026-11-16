import type { IBranchPathNode } from '../services/staffWeekendService';
import type { OrgDepartmentNode } from '../types/organization';
import { branchOptionLabel, type IBranchOption } from './branchSelect';

/**
 * Список отделов вкладок кадров («Выходные», «Корректировки») — деревом для DepartmentTreeSelect, как в «Текущих
 * сотрудниках»: пункты — отделы с данными «Название (N)», их предки — серые заголовки (in_scope: false), выбрать их
 * нельзя. Порядок — как пришли пункты (сервер сортирует по пути в дереве). Нет предков (прежний сервер) — пункт корнем.
 */

interface IBranchWithPath {
  id: string;
  name: string;
  path?: ReadonlyArray<IBranchPathNode>;
}

const makeNode = (id: string, parentId: string | null, name: string, inScope: boolean, sortOrder: number): OrgDepartmentNode => ({
  id,
  parent_id: parentId,
  sigur_department_id: null,
  name,
  description: null,
  sort_order: sortOrder,
  is_active: true,
  kind: 'department',
  created_at: '',
  updated_at: '',
  children: [],
  in_scope: inScope,
});

export const buildBranchTree = (
  options: ReadonlyArray<IBranchOption>,
  branches: ReadonlyArray<IBranchWithPath>,
): OrgDepartmentNode[] => {
  const pathById = new Map(branches.map(branch => [branch.id, branch.path ?? []]));
  const nodes = new Map<string, OrgDepartmentNode>();
  const roots: OrgDepartmentNode[] = [];
  let order = 0;

  const attach = (node: OrgDepartmentNode, parentId: string | null): void => {
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  };

  for (const option of options) {
    let parentId: string | null = null;
    for (const ancestor of pathById.get(option.id) ?? []) {
      if (!nodes.has(ancestor.id)) {
        const node = makeNode(ancestor.id, parentId, ancestor.name, false, order += 1);
        nodes.set(ancestor.id, node);
        attach(node, parentId);
      }
      parentId = ancestor.id;
    }
    const existing = nodes.get(option.id);
    if (existing) {
      // Отдел уже стоял предком другого пункта: теперь он и сам пункт.
      existing.name = branchOptionLabel(option);
      existing.in_scope = true;
      continue;
    }
    const node = makeNode(option.id, parentId, branchOptionLabel(option), true, order += 1);
    nodes.set(option.id, node);
    attach(node, parentId);
  }
  return roots;
};
