import { useMemo, type FC } from 'react';
import { ChevronRight, Folder, Users, RefreshCw, Search, X } from 'lucide-react';
import type { OrgDepartmentNode } from '../../types';

interface IDepartmentPanelProps {
  departments: OrgDepartmentNode[];
  selectedDeptId: string | null;
  expandedDepts: Set<string>;
  deptCounts: Map<string, number>;
  totalActive: number;
  highlightedDeptIds?: Set<string>;
  deptSearch: string;
  visibleDeptIds?: Set<string>;
  searchValue?: string;
  onSearchChange?: (v: string) => void;
  onSelectDept: (id: string | null) => void;
  onToggleDept: (id: string) => void;
  onRefresh: () => void;
}

export const DepartmentPanel: FC<IDepartmentPanelProps> = ({
  departments, selectedDeptId, expandedDepts, deptCounts, totalActive,
  highlightedDeptIds, deptSearch, visibleDeptIds, searchValue, onSearchChange,
  onSelectDept, onToggleDept, onRefresh,
}) => {

  const filteredDepts = useMemo(() => {
    if (visibleDeptIds) {
      const filterById = (nodes: OrgDepartmentNode[]): OrgDepartmentNode[] =>
        nodes.reduce<OrgDepartmentNode[]>((acc, node) => {
          const children = filterById(node.children);
          if (visibleDeptIds.has(node.id) || children.length > 0) {
            acc.push({ ...node, children });
          }
          return acc;
        }, []);
      return filterById(departments);
    }
    if (!deptSearch) return departments;
    const q = deptSearch.toLowerCase();
    const filterTree = (nodes: OrgDepartmentNode[]): OrgDepartmentNode[] =>
      nodes.reduce<OrgDepartmentNode[]>((acc, node) => {
        const children = filterTree(node.children);
        if (node.name.toLowerCase().includes(q) || children.length > 0) {
          acc.push({ ...node, children });
        }
        return acc;
      }, []);
    return filterTree(departments);
  }, [departments, deptSearch, visibleDeptIds]);

  const renderDeptNode = (node: OrgDepartmentNode, level = 0) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = deptSearch ? true : expandedDepts.has(node.id);
    const isSelected = selectedDeptId === node.id;
    const isHighlighted = !isSelected && (highlightedDeptIds?.has(node.id) ?? false);
    const count = deptCounts.get(node.id) || 0;

    return (
      <div key={node.id} className="ep-dept-item">
        <div
          className={`ep-dept-header ${isSelected ? 'active' : ''} ${isHighlighted ? 'highlighted' : ''}`}
          style={{ paddingLeft: `${12 + level * 20}px` }}
          onClick={() => onSelectDept(isSelected ? null : node.id)}
        >
          <button
            className={`ep-dept-toggle ${hasChildren ? (isExpanded ? 'expanded' : '') : 'empty'}`}
            onClick={(e) => { e.stopPropagation(); onToggleDept(node.id); }}
          >
            <ChevronRight size={14} />
          </button>
          <Folder size={16} className="ep-dept-icon" />
          <span className="ep-dept-name">{node.name}</span>
          {count > 0 && <span className="ep-dept-count">{count}</span>}
        </div>
        {hasChildren && isExpanded && (
          <div className="ep-dept-children">
            {node.children.map(child => renderDeptNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="ep-dept-panel">
      <div className="ep-dept-panel-header">
        <div className="ep-panel-title">
          <Folder size={16} />
          <span>Отделы</span>
        </div>
        <div className="ep-panel-actions">
          <button className="ep-panel-btn" onClick={onRefresh} title="Обновить">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {onSearchChange && (
        <div className="ep-dept-search-wrap">
          <Search size={14} />
          <input
            type="text"
            value={searchValue ?? ''}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Поиск по имени или отделу..."
          />
          {searchValue && (
            <button className="ep-search-clear" onClick={() => onSearchChange('')}>
              <X size={13} />
            </button>
          )}
        </div>
      )}
      <div className="ep-dept-tree">
        <div
          className={`ep-dept-header ep-dept-all ${!selectedDeptId ? 'active' : ''}`}
          onClick={() => onSelectDept(null)}
        >
          <Users size={16} className="ep-dept-icon" />
          <span className="ep-dept-name">Все сотрудники</span>
          <span className="ep-dept-count">{totalActive}</span>
        </div>
        {filteredDepts.map(dept => renderDeptNode(dept))}
      </div>
    </div>
  );
};
