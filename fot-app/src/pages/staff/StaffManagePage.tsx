import { useState, useEffect, useCallback, useMemo, type FC } from 'react';
import { structureApi } from '../../api/structure';
import { employeeService } from '../../services/employeeService';
import type { Employee, OrgDepartmentNode } from '../../types';
import styles from './StaffManagePage.module.css';

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

export const StaffManagePage: FC = () => {
  const [departments, setDepartments] = useState<IDeptFlat[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [deptLoading, setDeptLoading] = useState(true);
  const [deptSearch, setDeptSearch] = useState('');
  const [empSearch, setEmpSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [moveTarget, setMoveTarget] = useState<Employee | null>(null);
  const [moveSearch, setMoveSearch] = useState('');
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  // Load departments
  useEffect(() => {
    const load = async () => {
      setDeptLoading(true);
      const res = await structureApi.getTree();
      if (res.success && res.data) {
        setDepartments(flattenTree(res.data.departments));
      }
      setDeptLoading(false);
    };
    load();
  }, []);

  // Load employees when department selected
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

  useEffect(() => {
    loadEmployees(selectedDeptId);
  }, [selectedDeptId, loadEmployees]);

  // Filtered departments
  const filteredDepts = useMemo(() => {
    if (!deptSearch.trim()) return departments;
    const q = deptSearch.toLowerCase().trim();
    return departments.filter(d => d.name.toLowerCase().includes(q));
  }, [departments, deptSearch]);

  // Filtered employees: "all" shows only active, "fired" shows fired
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

  const selectedDeptName = departments.find(d => d.id === selectedDeptId)?.name || '';

  // Actions
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
      // Reload employees for current department
      await loadEmployees(selectedDeptId);
    } catch { /* ignore */ }
    setMoveTarget(null);
    setMoveSearch('');
    setActionLoading(null);
  };

  // Stats
  const activeCount = employees.filter(e => e.employment_status === 'active').length;
  const firedCount = employees.filter(e => e.employment_status === 'fired').length;

  // Filtered departments for move modal
  const moveDepts = useMemo(() => {
    if (!moveSearch.trim()) return departments;
    const q = moveSearch.toLowerCase().trim();
    return departments.filter(d => d.name.toLowerCase().includes(q));
  }, [departments, moveSearch]);

  return (
    <div className={styles.container}>
      {/* Department sidebar */}
      <div className={styles.sidebar}>
        <p className={styles.sidebarTitle}>Отделы</p>
        <input
          className={styles.deptSearch}
          type="text"
          placeholder="Поиск отдела..."
          value={deptSearch}
          onChange={e => setDeptSearch(e.target.value)}
        />
        <div className={styles.deptList}>
          {deptLoading ? (
            <div className={styles.loading}>
              <div className={styles.spinner} />
            </div>
          ) : filteredDepts.length === 0 ? (
            <div className={styles.empty}>Нет отделов</div>
          ) : (
            filteredDepts.map(dept => (
              <div
                key={dept.id}
                className={`${styles.deptItem} ${selectedDeptId === dept.id ? styles.deptItemActive : ''}`}
                style={{ paddingLeft: 10 + dept.level * 14 }}
                onClick={() => setSelectedDeptId(dept.id)}
              >
                <span className={styles.deptIcon}>●</span>
                <span className={styles.deptName}>{dept.name}</span>
              </div>
            ))
          )}
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

export default StaffManagePage;
