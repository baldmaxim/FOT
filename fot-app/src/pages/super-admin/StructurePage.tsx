import { useState, useEffect, useCallback, type FC } from 'react';
import { structureApi } from '../../api/structure';
import { useAuth } from '../../contexts/AuthContext';
import type { OrgDepartmentNode, OrgStructureResponse } from '../../types';
import styles from './StructurePage.module.css';

const countEmployeesInBranch = (node: OrgDepartmentNode): number => {
  let total = 0;
  for (const child of node.children) {
    total += countEmployeesInBranch(child);
  }
  return total;
};

export const StructurePage: FC = () => {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [structure, setStructure] = useState<OrgStructureResponse | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [addingTo, setAddingTo] = useState<string | null>(null); // 'root' | parentId | null
  const [newDeptName, setNewDeptName] = useState('');
  const [creating, setCreating] = useState(false);

  const loadStructure = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await structureApi.getTree();
      if (response.success && response.data) {
        setStructure(response.data);
        // Раскрываем первый уровень
        const expanded = new Set<string>();
        for (const dept of response.data.departments) {
          expanded.add(dept.id);
        }
        setExpandedNodes(expanded);
      } else {
        setError(response.error || 'Ошибка загрузки');
      }
    } catch {
      setError('Ошибка загрузки структуры');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStructure();
  }, [loadStructure]);

  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => {
    const all = new Set<string>();
    const collect = (nodes: OrgDepartmentNode[]) => {
      for (const n of nodes) {
        all.add(n.id);
        collect(n.children);
      }
    };
    if (structure) collect(structure.departments);
    setExpandedNodes(all);
  };

  const collapseAll = () => setExpandedNodes(new Set());

  const startAdding = (parentId: string | null) => {
    setAddingTo(parentId ?? 'root');
    setNewDeptName('');
  };

  const cancelAdding = () => {
    setAddingTo(null);
    setNewDeptName('');
  };

  const handleCreate = async () => {
    if (!newDeptName.trim() || creating) return;
    setCreating(true);
    const parentId = addingTo === 'root' ? null : addingTo;
    const orgId = profile?.organization_id || structure?.departments[0]?.organization_id;
    const res = await structureApi.createDepartment(newDeptName.trim(), undefined, orgId || undefined, parentId);
    setCreating(false);
    if (res.success) {
      cancelAdding();
      await loadStructure();
    } else {
      setError(res.error || 'Ошибка создания отдела');
    }
  };

  const renderInlineForm = (level: number) => (
    <div className={styles.inlineForm} style={{ paddingLeft: 12 + level * 20 }}>
      <input
        className={styles.inlineInput}
        type="text"
        placeholder="Название отдела"
        value={newDeptName}
        onChange={(e) => setNewDeptName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCreate();
          if (e.key === 'Escape') cancelAdding();
        }}
        autoFocus
      />
      <button className={styles.inlineSubmit} onClick={handleCreate} disabled={!newDeptName.trim() || creating}>
        {creating ? '...' : 'Создать'}
      </button>
      <button className={styles.inlineCancel} onClick={cancelAdding}>Отмена</button>
    </div>
  );

  const filterTree = (nodes: OrgDepartmentNode[], query: string): OrgDepartmentNode[] => {
    if (!query.trim()) return nodes;
    const q = query.toLowerCase().trim();
    return nodes.reduce<OrgDepartmentNode[]>((acc, node) => {
      const childMatches = filterTree(node.children, query);
      const selfMatch = node.name.toLowerCase().includes(q);
      if (selfMatch || childMatches.length > 0) {
        acc.push({ ...node, children: childMatches.length > 0 ? childMatches : node.children });
      }
      return acc;
    }, []);
  };

  const displayTree = structure
    ? (searchQuery ? filterTree(structure.departments, searchQuery) : structure.departments)
    : [];

  const renderNode = (node: OrgDepartmentNode, level: number) => {
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children.length > 0;
    const isAddingHere = addingTo === node.id;

    return (
      <div key={node.id} className={styles.treeNode}>
        <div
          className={`${styles.nodeHeader} ${hasChildren ? styles.branchNode : styles.leafNode}`}
          style={{ paddingLeft: 12 + level * 20 }}
          onClick={() => hasChildren && toggleNode(node.id)}
        >
          {hasChildren ? (
            <span className={styles.expandIcon}>{isExpanded ? '▾' : '▸'}</span>
          ) : (
            <span className={styles.leafIcon}>●</span>
          )}
          <span className={styles.nodeName}>{node.name}</span>
          <button
            className={styles.nodeAddBtn}
            title="Добавить подотдел"
            onClick={(e) => { e.stopPropagation(); startAdding(node.id); }}
          >+</button>
        </div>

        {(isExpanded || isAddingHere) && (
          <div className={styles.nodeChildren}>
            {hasChildren && node.children.map((child) => renderNode(child, level + 1))}
            {isAddingHere && renderInlineForm(level + 1)}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <span>Загрузка структуры...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Структура организации</h1>
          {structure && (
            <p className={styles.stats}>Отделов: {structure.stats.departments}</p>
          )}
        </div>
        <button className={styles.refreshBtn} onClick={loadStructure} title="Обновить">↻</button>
      </div>

      {error && (
        <div className={styles.error}>
          {error}
          <button onClick={loadStructure}>Повторить</button>
        </div>
      )}

      {!error && structure && (
        <>
          <div className={styles.toolbar}>
            <input
              className={styles.searchInput}
              type="text"
              placeholder="Поиск отдела..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div className={styles.toolbarActions}>
              <button className={styles.addBtn} onClick={() => startAdding(null)}>+ Добавить отдел</button>
              <button className={styles.toolbarBtn} onClick={expandAll}>Развернуть</button>
              <button className={styles.toolbarBtn} onClick={collapseAll}>Свернуть</button>
            </div>
          </div>

          <div className={styles.tree}>
            {displayTree.length === 0 ? (
              <div className={styles.empty}>
                {searchQuery ? 'Ничего не найдено' : 'Структура пуста'}
              </div>
            ) : (
              displayTree.map((node) => renderNode(node, 0))
            )}
            {addingTo === 'root' && renderInlineForm(0)}
          </div>
        </>
      )}
    </div>
  );
};

export default StructurePage;
