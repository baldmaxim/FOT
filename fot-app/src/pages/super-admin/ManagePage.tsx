import { useState, useEffect, useCallback, useMemo, type FC, type JSX } from 'react';
import { structureApi } from '../../api/structure';
import { employeeService } from '../../services/employeeService';
import { useAuth } from '../../contexts/AuthContext';
import type { Employee, OrgDepartmentNode, OrgStructureResponse } from '../../types';
import styles from './ManagePage.module.css';

interface IDeptFlat {
  id: string;
  name: string;
  level: number;
}

type StatusFilter = 'all' | 'fired';

const flattenTree = (nodes: OrgDepartmentNode[], level = 0): IDeptFlat[] => {
  const result: IDeptFlat[] = [];
  for (const node of nodes) {
    result.push({ id: node.id, name: node.name, level });
    if (node.children.length > 0) {
      result.push(...flattenTree(node.children, level + 1));
    }
  }
  return result;
};

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

export const ManagePage: FC = () => {
  const { profile, positionType } = useAuth();
  const isHeaderOnly = positionType === 'header';

  // Structure state
  const [structure, setStructure] = useState<OrgStructureResponse | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newDeptName, setNewDeptName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deptLoading, setDeptLoading] = useState(true);
  const [deptSearch, setDeptSearch] = useState('');

  // Employee state
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [empSearch, setEmpSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [moveTarget, setMoveTarget] = useState<Employee | null>(null);
  const [moveSearch, setMoveSearch] = useState('');
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  // Load structure
  const loadStructure = useCallback(async () => {
    try {
      setDeptLoading(true);
      setError(null);
      const response = await structureApi.getTree();
      if (response.success && response.data) {
        setStructure(response.data);
        setExpandedNodes(prev => {
          if (prev.size > 0) return prev;
          const expanded = new Set<string>();
          for (const dept of response.data!.departments) {
            expanded.add(dept.id);
          }
          return expanded;
        });
      } else {
        setError(response.error || 'Ошибка загрузки');
      }
    } catch {
      setError('Ошибка загрузки структуры');
    } finally {
      setDeptLoading(false);
    }
  }, []);

  useEffect(() => { loadStructure(); }, [loadStructure]);

  // Load employees
  const loadEmployees = useCallback(async (deptId: string | null) => {
    if (!deptId) { setEmployees([]); return; }
    setLoading(true);
    try {
      const data = await employeeService.getAll({ departmentId: deptId });
      setEmployees(data);
    } catch {
      setEmployees([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadEmployees(selectedDeptId); }, [selectedDeptId, loadEmployees]);

  // Tree operations
  const toggleNode = (id: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startAdding = (parentId: string | null) => {
    setAddingTo(parentId ?? 'root');
    setNewDeptName('');
    if (parentId) {
      setExpandedNodes(prev => new Set(prev).add(parentId));
    }
  };

  const cancelAdding = () => {
    setAddingTo(null);
    setNewDeptName('');
  };

  const handleCreateDept = async () => {
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

  const handleDeleteDept = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Удалить этот отдел?')) return;
    const orgId = profile?.organization_id || structure?.departments[0]?.organization_id;
    const res = await structureApi.deleteDepartment(id, orgId || undefined);
    if (res.success) {
      if (selectedDeptId === id) {
        setSelectedDeptId(null);
        setEmployees([]);
      }
      await loadStructure();
    } else {
      setError(res.error || 'Ошибка удаления отдела');
    }
  };

  // Employee actions
  const handleFire = async (emp: Employee) => {
    setActionLoading(emp.id);
    try {
      const updated = await employeeService.fire(emp.id);
      setEmployees(prev => prev.map(e => e.id === emp.id ? { ...e, ...updated } : e));
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const handleRehire = async (emp: Employee) => {
    setActionLoading(emp.id);
    try {
      const updated = await employeeService.rehire(emp.id);
      setEmployees(prev => prev.map(e => e.id === emp.id ? { ...e, ...updated } : e));
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const handleMove = async (empId: number, newDeptId: string) => {
    setActionLoading(empId);
    try {
      await employeeService.moveDepartment(empId, newDeptId);
      await loadEmployees(selectedDeptId);
    } catch { /* ignore */ }
    setMoveTarget(null);
    setMoveSearch('');
    setActionLoading(null);
  };

  // Для header: фильтруем дерево только до своего отдела
  const scopedDepartments = useMemo(() => {
    if (!structure) return [];
    if (!isHeaderOnly || !profile?.department_id) return structure.departments;

    // Ищем отдел header'а в дереве (рекурсивно)
    const findDept = (nodes: OrgDepartmentNode[]): OrgDepartmentNode | null => {
      for (const node of nodes) {
        if (node.id === profile.department_id) return node;
        const found = findDept(node.children);
        if (found) return found;
      }
      return null;
    };
    const myDept = findDept(structure.departments);
    return myDept ? [myDept] : [];
  }, [structure, isHeaderOnly, profile?.department_id]);

  // Автоматически выбрать отдел header'а
  useEffect(() => {
    if (isHeaderOnly && profile?.department_id && !selectedDeptId) {
      setSelectedDeptId(profile.department_id);
    }
  }, [isHeaderOnly, profile?.department_id, selectedDeptId]);

  // Computed
  const displayTree = useMemo(() =>
    deptSearch ? filterTree(scopedDepartments, deptSearch) : scopedDepartments,
    [scopedDepartments, deptSearch]
  );

  const flatDepts = useMemo(() =>
    flattenTree(scopedDepartments),
    [scopedDepartments]
  );

  const filteredEmployees = useMemo(() => {
    let list = employees;
    if (statusFilter === 'all') list = list.filter(e => e.employment_status !== 'fired');
    if (statusFilter === 'fired') list = list.filter(e => e.employment_status === 'fired');
    if (empSearch.trim()) {
      const q = empSearch.toLowerCase().trim();
      list = list.filter(e => e.full_name.toLowerCase().includes(q));
    }
    return list;
  }, [employees, statusFilter, empSearch]);

  const activeCount = employees.filter(e => e.employment_status === 'active').length;
  const firedCount = employees.filter(e => e.employment_status === 'fired').length;

  const moveDepts = useMemo(() => {
    if (!moveSearch.trim()) return flatDepts;
    const q = moveSearch.toLowerCase().trim();
    return flatDepts.filter(d => d.name.toLowerCase().includes(q));
  }, [flatDepts, moveSearch]);

  const selectedDeptName = flatDepts.find(d => d.id === selectedDeptId)?.name || '';

  // Render helpers
  const renderInlineForm = (level: number) => (
    <div className={styles.inlineForm} style={{ paddingLeft: 8 + level * 14 }}>
      <input
        className={styles.inlineInput}
        type="text"
        placeholder="Название отдела"
        value={newDeptName}
        onChange={e => setNewDeptName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleCreateDept();
          if (e.key === 'Escape') cancelAdding();
        }}
        autoFocus
      />
      <button className={styles.inlineSubmit} onClick={handleCreateDept} disabled={!newDeptName.trim() || creating}>
        {creating ? '...' : 'ОК'}
      </button>
      <button className={styles.inlineCancel} onClick={cancelAdding}>✕</button>
    </div>
  );

  const renderNode = (node: OrgDepartmentNode, level: number): JSX.Element => {
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children.length > 0;
    const isSelected = selectedDeptId === node.id;
    const isAddingHere = addingTo === node.id;

    return (
      <div key={node.id} className={styles.treeNode}>
        <div
          className={`${styles.nodeHeader} ${isSelected ? styles.nodeActive : ''}`}
          style={{ paddingLeft: 8 + level * 14 }}
          onClick={() => {
            setSelectedDeptId(node.id);
            if (hasChildren) toggleNode(node.id);
          }}
        >
          {hasChildren ? (
            <span className={styles.expandIcon}>{isExpanded ? '▾' : '▸'}</span>
          ) : (
            <span className={styles.leafIcon}>●</span>
          )}
          <span className={styles.nodeName}>{node.name}</span>
          {!isHeaderOnly && <button
            className={styles.nodeAddBtn}
            title="Добавить подотдел"
            onClick={e => { e.stopPropagation(); startAdding(node.id); }}
          >+</button>}
          {!isHeaderOnly && <button
            className={styles.nodeDeleteBtn}
            title="Удалить отдел"
            onClick={e => handleDeleteDept(node.id, e)}
          >×</button>}
        </div>
        {(isExpanded || isAddingHere) && (
          <div className={styles.nodeChildren}>
            {hasChildren && node.children.map(child => renderNode(child, level + 1))}
            {isAddingHere && renderInlineForm(level + 1)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.container}>
      {/* Department sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <p className={styles.sidebarTitle}>Отделы</p>
          <div className={styles.sidebarActions}>
            {!isHeaderOnly && <button className={styles.sidebarBtnAdd} onClick={() => startAdding(null)} title="Добавить отдел">+</button>}
            <button className={styles.sidebarBtn} onClick={loadStructure} title="Обновить">↻</button>
          </div>
        </div>
        <input
          className={styles.deptSearch}
          type="text"
          placeholder="Поиск отдела..."
          value={deptSearch}
          onChange={e => setDeptSearch(e.target.value)}
        />
        {error && <div className={styles.sidebarError}>{error}</div>}
        <div className={styles.deptList}>
          {deptLoading ? (
            <div className={styles.loading}>
              <div className={styles.spinner} />
            </div>
          ) : displayTree.length === 0 ? (
            <div className={styles.empty}>
              {deptSearch ? 'Ничего не найдено' : 'Нет отделов'}
            </div>
          ) : (
            displayTree.map(node => renderNode(node, 0))
          )}
          {addingTo === 'root' && renderInlineForm(0)}
        </div>
      </div>

      {/* Employee list */}
      <div className={styles.main}>
        {!selectedDeptId ? (
          <div className={styles.selectDept}>Выберите отдел для управления сотрудниками</div>
        ) : (
          <>
            <div className={styles.mainHeader}>
              <h2 className={styles.mainTitle}>
                {selectedDeptName}
                <span className={styles.empCount}>{employees.length} чел.</span>
              </h2>
              <div className={styles.filterTabs}>
                <button
                  className={`${styles.filterTab} ${statusFilter === 'all' ? styles.filterTabActive : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  Все ({activeCount})
                </button>
                <button
                  className={`${styles.filterTab} ${statusFilter === 'fired' ? styles.filterTabActive : ''}`}
                  onClick={() => setStatusFilter('fired')}
                >
                  Уволенные ({firedCount})
                </button>
              </div>
            </div>

            <input
              className={styles.empSearch}
              type="text"
              placeholder="Поиск по имени..."
              value={empSearch}
              onChange={e => setEmpSearch(e.target.value)}
            />

            <div className={styles.empList}>
              {loading ? (
                <div className={styles.loading}>
                  <div className={styles.spinner} />
                  <span>Загрузка...</span>
                </div>
              ) : filteredEmployees.length === 0 ? (
                <div className={styles.empty}>
                  {empSearch ? 'Ничего не найдено' : 'Нет сотрудников в этом отделе'}
                </div>
              ) : (
                filteredEmployees.map(emp => (
                  <div key={emp.id} className={styles.empRow}>
                    <div className={styles.empInfo}>
                      <div className={styles.empName}>
                        {emp.full_name}
                        {emp.employment_status === 'fired' && (
                          <span className={`${styles.badge} ${styles.badgeFired}`}>Уволен</span>
                        )}
                        {emp.department_locked && (
                          <span className={`${styles.badge} ${styles.badgeLocked}`} title="Отдел зафиксирован вручную, Sigur не обновляет">
                            🔒
                          </span>
                        )}
                      </div>
                      {emp.position_name && (
                        <div className={styles.empPosition}>{emp.position_name}</div>
                      )}
                    </div>
                    {!isHeaderOnly && (
                      <div className={styles.empActions}>
                        {emp.employment_status === 'active' ? (
                          <button
                            className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                            onClick={() => handleFire(emp)}
                            disabled={actionLoading === emp.id}
                          >
                            Уволить
                          </button>
                        ) : (
                          <button
                            className={`${styles.actionBtn} ${styles.actionBtnSuccess}`}
                            onClick={() => handleRehire(emp)}
                            disabled={actionLoading === emp.id}
                          >
                            Восстановить
                          </button>
                        )}
                        <button
                          className={styles.actionBtn}
                          onClick={() => { setMoveTarget(emp); setMoveSearch(''); }}
                          disabled={actionLoading === emp.id}
                        >
                          Переместить
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* Move department modal */}
      {moveTarget && (
        <div className={styles.modalOverlay} onClick={() => setMoveTarget(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Переместить в отдел</h3>
            <p className={styles.modalSub}>{moveTarget.full_name}</p>
            <input
              className={styles.modalSearch}
              type="text"
              placeholder="Поиск отдела..."
              value={moveSearch}
              onChange={e => setMoveSearch(e.target.value)}
              autoFocus
            />
            <div className={styles.modalDeptList}>
              {moveDepts.map(dept => (
                <button
                  key={dept.id}
                  className={styles.modalDeptItem}
                  style={{ paddingLeft: 10 + dept.level * 14 }}
                  onClick={() => handleMove(moveTarget.id, dept.id)}
                  disabled={actionLoading === moveTarget.id}
                >
                  {dept.name}
                </button>
              ))}
            </div>
            <div className={styles.modalActions}>
              <button className={styles.modalCancel} onClick={() => setMoveTarget(null)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ManagePage;
