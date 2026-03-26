import { useState, useEffect, useMemo, type FC } from 'react';
import { ChevronDown, ChevronRight, Building2, Users } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { Employee } from '../../types';
import '../../styles/EmployeeTreeView.css';

interface IDbDepartment {
  id: string;
  name: string;
  parent_id: string | null;
  children: IDbDepartment[];
}

interface IEmployeeTreeViewProps {
  employees: Employee[];
  searchQuery: string;
  onEmployeeClick: (emp: Employee) => void;
}

export const EmployeeTreeView: FC<IEmployeeTreeViewProps> = ({
  employees,
  searchQuery,
  onEmployeeClick,
}) => {
  const [tree, setTree] = useState<IDbDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await apiClient.get<{ success: boolean; data: { departments: IDbDepartment[] } }>('/structure');
        if (cancelled) return;
        const departments = res.data?.departments || [];
        setTree(departments);
        const initial = new Set<string>();
        departments.forEach(n => initial.add(n.id));
        setExpandedNodes(initial);
      } catch {
        if (!cancelled) setTree([]);
      }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const employeesByDeptId = useMemo(() => {
    const map = new Map<string, Employee[]>();
    employees.forEach(emp => {
      const key = emp.org_department_id || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(emp);
    });
    return map;
  }, [employees]);

  const flatMap = useMemo(() => {
    const map = new Map<string, IDbDepartment>();
    const flatten = (nodes: IDbDepartment[]) => {
      nodes.forEach(n => { map.set(n.id, n); flatten(n.children); });
    };
    flatten(tree);
    return map;
  }, [tree]);

  const getEmpsForNode = (node: IDbDepartment): Employee[] =>
    employeesByDeptId.get(node.id) || [];

  const countBranch = useMemo(() => {
    const cache = new Map<string, number>();
    const count = (node: IDbDepartment): number => {
      if (cache.has(node.id)) return cache.get(node.id)!;
      let total = (employeesByDeptId.get(node.id) || []).length;
      node.children.forEach(child => { total += count(child); });
      cache.set(node.id, total);
      return total;
    };
    tree.forEach(n => count(n));
    return cache;
  }, [tree, employeesByDeptId]);

  const visibleNodeIds = useMemo(() => {
    if (!searchQuery && employees.length === 0) return null;
    const ids = new Set<string>();
    const addAncestors = (nodeId: string) => {
      let current = flatMap.get(nodeId);
      while (current) {
        if (ids.has(current.id)) break;
        ids.add(current.id);
        current = current.parent_id ? flatMap.get(current.parent_id) : undefined;
      }
    };
    const walkTree = (nodes: IDbDepartment[]) => {
      nodes.forEach(n => {
        if ((employeesByDeptId.get(n.id) || []).length > 0) addAncestors(n.id);
        walkTree(n.children);
      });
    };
    walkTree(tree);
    return ids;
  }, [searchQuery, employees, tree, flatMap, employeesByDeptId]);

  const toggleNode = (id: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const renderEmployeeRow = (emp: Employee) => (
    <div
      key={emp.id}
      className={`tree-emp-row ${emp.is_archived ? 'tree-emp-archived' : ''}`}
      onClick={() => onEmployeeClick(emp)}
    >
      <span className="tree-emp-name">{emp.full_name}</span>
      <span className="tree-emp-position">{emp.position_name || '—'}</span>
    </div>
  );

  const renderDeptNode = (node: IDbDepartment, level: number) => {
    const count = countBranch.get(node.id) || 0;
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children.length > 0;
    const nodeEmployees = getEmpsForNode(node);

    if (visibleNodeIds && !visibleNodeIds.has(node.id) && count === 0) return null;

    return (
      <div key={node.id} className="dept-node">
        <div
          className="dept-header"
          style={{ paddingLeft: 12 + level * 24 }}
          onClick={() => toggleNode(node.id)}
        >
          <span className="dept-expand">
            {(hasChildren || nodeEmployees.length > 0)
              ? (isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />)
              : <span className="dept-expand-placeholder" />
            }
          </span>
          <Building2 size={16} className="dept-icon" />
          <span className="dept-name">{node.name}</span>
          {count > 0 && <span className="dept-count">{count}</span>}
        </div>

        {isExpanded && (
          <div className="dept-children">
            {hasChildren && node.children.map(child => renderDeptNode(child, level + 1))}
            {nodeEmployees.length > 0 && (
              <div className="dept-employees" style={{ paddingLeft: 12 + (level + 1) * 24 }}>
                {nodeEmployees.map(renderEmployeeRow)}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return <div className="loading">Загрузка структуры...</div>;
  }

  const unassigned = employees.filter(emp => !emp.org_department_id);
  const hasTree = tree.length > 0;

  return (
    <div className="employee-tree">
      {hasTree && tree.map(node => renderDeptNode(node, 0))}

      {unassigned.length > 0 && (
        <div className="dept-node unassigned-section">
          <div
            className="dept-header unassigned-header"
            onClick={() => toggleNode('__unassigned__')}
          >
            <span className="dept-expand">
              {expandedNodes.has('__unassigned__') ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
            <Users size={16} className="dept-icon" />
            <span className="dept-name">Без отдела</span>
            <span className="dept-count">{unassigned.length}</span>
          </div>
          {expandedNodes.has('__unassigned__') && (
            <div className="dept-children">
              <div className="dept-employees" style={{ paddingLeft: 36 }}>
                {unassigned.map(renderEmployeeRow)}
              </div>
            </div>
          )}
        </div>
      )}

      {!hasTree && unassigned.length === 0 && (
        <div className="empty-state">
          <Users size={48} />
          <p>Сотрудники не найдены</p>
        </div>
      )}
    </div>
  );
};
