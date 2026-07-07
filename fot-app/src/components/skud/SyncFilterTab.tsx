import { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Save, Check, RefreshCw, Info, ChevronRight, ChevronDown, Folder, FolderOpen } from 'lucide-react';
import { sigurService } from '../../services/sigurService';
import { compareDepartmentNames } from '../../utils/departmentUtils';
import '../../styles/SigurSettingsPage.css';

interface ISigurDepartment {
  id: number;
  name: string;
  parentId?: number;
}

interface ITreeNode {
  dept: ISigurDepartment;
  children: ITreeNode[];
}

interface IDepartmentHierarchyMaps {
  childIdsByParentId: Map<number, number[]>;
  parentIdById: Map<number, number | null>;
}

interface ISyncFilterTabProps {
  connected: boolean | null;
  canEdit: boolean;
  onFilterCountChange?: (count: number) => void;
}

type SortMode = 'alpha' | 'id';

const buildTree = (depts: ISigurDepartment[], sortMode: SortMode): ITreeNode[] => {
  const byId = new Map<number, ITreeNode>();
  for (const dept of depts) {
    byId.set(dept.id, { dept, children: [] });
  }

  const roots: ITreeNode[] = [];
  for (const dept of depts) {
    const node = byId.get(dept.id)!;
    if (dept.parentId && byId.has(dept.parentId)) {
      byId.get(dept.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const comparator = sortMode === 'alpha'
    ? (a: ITreeNode, b: ITreeNode) => compareDepartmentNames(a.dept.name, b.dept.name)
    : (a: ITreeNode, b: ITreeNode) => a.dept.id - b.dept.id;

  const sortNodes = (nodes: ITreeNode[]) => {
    nodes.sort(comparator);
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
};

const getAllDescendantIds = (node: ITreeNode): number[] => {
  const ids: number[] = [];
  for (const child of node.children) {
    ids.push(child.dept.id);
    ids.push(...getAllDescendantIds(child));
  }
  return ids;
};

const buildDepartmentHierarchyMaps = (depts: ISigurDepartment[]): IDepartmentHierarchyMaps => {
  const deptIds = new Set<number>(depts.map(dept => dept.id));
  const childIdsByParentId = new Map<number, number[]>();
  const parentIdById = new Map<number, number | null>();

  for (const dept of depts) {
    const parentId = typeof dept.parentId === 'number' && deptIds.has(dept.parentId)
      ? dept.parentId
      : null;
    parentIdById.set(dept.id, parentId);

    if (parentId === null) continue;
    const childIds = childIdsByParentId.get(parentId) || [];
    childIds.push(dept.id);
    childIdsByParentId.set(parentId, childIds);
  }

  return { childIdsByParentId, parentIdById };
};

const expandSelectedIdsToSubtree = (
  selectedIds: Set<number>,
  hierarchy: IDepartmentHierarchyMaps,
): Set<number> => {
  if (selectedIds.size === 0) return new Set();

  const expanded = new Set<number>();
  const queue = [...selectedIds];

  while (queue.length > 0) {
    const currentId = queue.pop()!;
    if (expanded.has(currentId)) continue;

    expanded.add(currentId);
    const childIds = hierarchy.childIdsByParentId.get(currentId) || [];
    for (const childId of childIds) {
      if (!expanded.has(childId)) queue.push(childId);
    }
  }

  return expanded;
};

const getMatchingIdsWithAncestors = (depts: ISigurDepartment[], query: string): Set<number> | null => {
  if (!query.trim()) return null;
  const q = query.toLowerCase();
  const matchIds = new Set<number>();
  const parentMap = new Map<number, number>();

  for (const d of depts) {
    if (d.parentId) parentMap.set(d.id, d.parentId);
    if (d.name.toLowerCase().includes(q)) matchIds.add(d.id);
  }

  const visible = new Set(matchIds);
  for (const id of matchIds) {
    let cur = parentMap.get(id);
    while (cur && !visible.has(cur)) {
      visible.add(cur);
      cur = parentMap.get(cur);
    }
  }
  return visible;
};

interface ITreeNodeRowProps {
  node: ITreeNode;
  depth: number;
  selectedIds: Set<number>;
  expandedIds: Set<number>;
  canEdit: boolean;
  visibleIds: Set<number> | null;
  onToggleSelect: (id: number, descendants: number[]) => void;
  onToggleExpand: (id: number) => void;
}

const TreeNodeRow = ({
  node,
  depth,
  selectedIds,
  expandedIds,
  canEdit,
  visibleIds,
  onToggleSelect,
  onToggleExpand,
}: ITreeNodeRowProps) => {
  const { dept, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(dept.id);
  const isSelected = selectedIds.has(dept.id);

  if (visibleIds && !visibleIds.has(dept.id)) return null;

  const allDescendants = getAllDescendantIds(node);
  const someChildrenSelected = hasChildren && allDescendants.some(id => selectedIds.has(id));

  const handleToggleSelect = () => {
    if (!canEdit) return;
    onToggleSelect(dept.id, allDescendants);
  };

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(dept.id);
  };

  const visibleChildren = hasChildren && isExpanded
    ? children.filter(c => !visibleIds || visibleIds.has(c.dept.id))
    : [];

  return (
    <>
      <div
        className={`sync-tree-row ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${12 + depth * 24}px` }}
        onClick={handleToggleSelect}
      >
        <span className="sync-tree-expand" onClick={hasChildren ? handleExpandClick : undefined}>
          {hasChildren ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : <span style={{ width: 14 }} />}
        </span>

        <input
          type="checkbox"
          className="sync-filter-checkbox"
          checked={isSelected}
          ref={el => {
            if (el) el.indeterminate = !isSelected && hasChildren && someChildrenSelected;
          }}
          onChange={handleToggleSelect}
          disabled={!canEdit}
          onClick={e => e.stopPropagation()}
        />

        <span className="sync-tree-icon">
          {hasChildren
            ? (isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />)
            : null}
        </span>

        <span className="sync-tree-name">{dept.name}</span>
        <span className="sync-tree-id">{dept.id}</span>
      </div>

      {isExpanded && visibleChildren.map(child => (
        <TreeNodeRow
          key={child.dept.id}
          node={child}
          depth={depth + 1}
          selectedIds={selectedIds}
          expandedIds={expandedIds}
          canEdit={canEdit}
          visibleIds={visibleIds}
          onToggleSelect={onToggleSelect}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </>
  );
};

export const SyncFilterTab = ({ connected, canEdit, onFilterCountChange }: ISyncFilterTabProps) => {
  const [sigurDepts, setSigurDepts] = useState<ISigurDepartment[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [initialIds, setInitialIds] = useState<Set<number>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('alpha');
  const [error, setError] = useState('');

  const hierarchy = useMemo(() => buildDepartmentHierarchyMaps(sigurDepts), [sigurDepts]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [deptsRes, filterRes] = await Promise.all([
        sigurService.getDepartments({ force: true }),
        sigurService.getSyncFilter(),
      ]);

      const depts: ISigurDepartment[] = ((deptsRes.data || []) as Record<string, unknown>[]).map(d => ({
        id: d.id as number,
        name: (d.name as string) || '',
        parentId: d.parentId as number | undefined,
      })).filter(d => d.name.trim());
      const deptHierarchy = buildDepartmentHierarchyMaps(depts);

      setSigurDepts(depts);

      // Expand all folders by default
      const folders = new Set<number>();
      for (const d of depts) {
        if (d.parentId) folders.add(d.parentId);
      }
      setExpandedIds(folders);

      const filterIds = new Set<number>(
        (filterRes || []).map(f => f.sigur_department_id)
      );
      const expandedFilterIds = expandSelectedIdsToSubtree(filterIds, deptHierarchy);
      setSelectedIds(expandedFilterIds);
      setInitialIds(expandedFilterIds);
      onFilterCountChange?.(expandedFilterIds.size);
    } catch {
      setError('Ошибка загрузки данных');
    } finally {
      setLoading(false);
    }
  }, [onFilterCountChange]);

  useEffect(() => {
    if (connected) loadData();
  }, [connected, loadData]);

  const tree = useMemo(() => buildTree(sigurDepts, sortMode), [sigurDepts, sortMode]);

  const visibleIds = useMemo(
    () => getMatchingIdsWithAncestors(sigurDepts, search),
    [sigurDepts, search],
  );

  // Auto-expand parents when searching
  useEffect(() => {
    if (visibleIds) {
      setExpandedIds(prev => {
        const next = new Set(prev);
        for (const id of visibleIds) next.add(id);
        return next;
      });
    }
  }, [visibleIds]);

  const isDirty = useMemo(() => {
    if (selectedIds.size !== initialIds.size) return true;
    for (const id of selectedIds) {
      if (!initialIds.has(id)) return true;
    }
    return false;
  }, [selectedIds, initialIds]);

  const handleToggleSelect = (id: number, descendants: number[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        // Снятие: убираем узел + всех потомков + всех предков.
        // Предки удаляются, чтобы ни один сохранённый предок не «покрывал»
        // исключённый узел через раскрытие в поддерево на бэкенде.
        next.delete(id);
        for (const d of descendants) next.delete(d);
        let ancestorId = hierarchy.parentIdById.get(id) ?? null;
        const visited = new Set<number>();
        while (ancestorId !== null && !visited.has(ancestorId)) {
          visited.add(ancestorId);
          next.delete(ancestorId);
          ancestorId = hierarchy.parentIdById.get(ancestorId) ?? null;
        }
      } else {
        // Выбор: добавляем узел + всех потомков, затем поднимаемся по предкам —
        // если у предка все прямые дети выбраны, отмечаем и его (bubble-up).
        next.add(id);
        for (const d of descendants) next.add(d);
        let ancestorId = hierarchy.parentIdById.get(id) ?? null;
        const visited = new Set<number>();
        while (ancestorId !== null && !visited.has(ancestorId)) {
          visited.add(ancestorId);
          const childIds = hierarchy.childIdsByParentId.get(ancestorId) ?? [];
          if (childIds.length > 0 && childIds.every(c => next.has(c))) {
            next.add(ancestorId);
          } else {
            break;
          }
          ancestorId = hierarchy.parentIdById.get(ancestorId) ?? null;
        }
      }
      return next;
    });
    setSaved(false);
  };

  const handleToggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedIds(new Set(sigurDepts.map(d => d.id)));
    setSaved(false);
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
    setSaved(false);
  };

  const handleExpandAll = () => {
    const folders = new Set<number>();
    for (const d of sigurDepts) {
      if (d.parentId) folders.add(d.parentId);
    }
    setExpandedIds(folders);
  };

  const handleCollapseAll = () => {
    setExpandedIds(new Set());
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const departments = sigurDepts
        .filter(d => selectedIds.has(d.id))
        .map(d => ({ sigur_department_id: d.id, sigur_department_name: d.name }));
      await sigurService.updateSyncFilter(departments);
      setInitialIds(new Set(selectedIds));
      onFilterCountChange?.(selectedIds.size);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Ошибка сохранения фильтра');
    } finally {
      setSaving(false);
    }
  };

  if (!connected) {
    return (
      <div className="sigur-section">
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          Нет подключения к Sigur
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="sigur-section">
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          Загрузка отделов Sigur...
        </div>
      </div>
    );
  }

  return (
    <div className="sigur-section sigur-section--full-height">
      {error && (
        <div className="sigur-error" style={{ marginBottom: '0.75rem' }}>
          {error}
          <button onClick={() => setError('')}>x</button>
        </div>
      )}

      <div className="sync-filter-header">
        <div className="sync-filter-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Поиск отдела..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="sync-filter-actions">
          <div className="sync-filter-sort-toggle">
            <button
              className={`sync-filter-sort-btn ${sortMode === 'alpha' ? 'active' : ''}`}
              onClick={() => setSortMode('alpha')}
            >
              А-Я
            </button>
            <button
              className={`sync-filter-sort-btn ${sortMode === 'id' ? 'active' : ''}`}
              onClick={() => setSortMode('id')}
            >
              ID
            </button>
          </div>
          {canEdit && (
            <>
              <button className="sigur-btn" onClick={handleSelectAll}>
                Выбрать все
              </button>
              <button className="sigur-btn" onClick={handleDeselectAll}>
                Снять все
              </button>
            </>
          )}
          <button className="sigur-btn" onClick={handleExpandAll} title="Развернуть все">
            <ChevronDown size={14} />
          </button>
          <button className="sigur-btn" onClick={handleCollapseAll} title="Свернуть все">
            <ChevronRight size={14} />
          </button>
          <button className="sigur-btn" onClick={loadData} title="Обновить список">
            <RefreshCw size={14} />
          </button>
          {canEdit && (
            <button
              className={`sigur-btn sigur-btn-primary ${saved ? 'sigur-btn-saved' : ''}`}
              onClick={handleSave}
              disabled={saving || !isDirty}
            >
              {saved ? <><Check size={14} /> Сохранено</> : <><Save size={14} /> Сохранить</>}
            </button>
          )}
        </div>
      </div>

      <div className="sync-filter-counter">
        Выбрано: <strong>{selectedIds.size}</strong> из {sigurDepts.length}
      </div>

      {selectedIds.size === 0 && (
        <div className="sync-filter-info">
          <Info size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          Если ничего не выбрано — портальные sync-процессы работают со всеми отделами Sigur
        </div>
      )}

      {sigurDepts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          Нет отделов в Sigur
        </div>
      ) : (
        <div className="sync-tree-wrap">
          {tree.map(node => (
            <TreeNodeRow
              key={node.dept.id}
              node={node}
              depth={0}
              selectedIds={selectedIds}
              expandedIds={expandedIds}
              canEdit={canEdit}
              visibleIds={visibleIds}
              onToggleSelect={handleToggleSelect}
              onToggleExpand={handleToggleExpand}
            />
          ))}
          {visibleIds && tree.every(n => !visibleIds.has(n.dept.id)) && (
            <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
              Не найдено
            </div>
          )}
        </div>
      )}
    </div>
  );
};
