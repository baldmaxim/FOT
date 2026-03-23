import { useState, useEffect, useCallback, useMemo, useRef, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, Upload, ChevronRight, Folder, Users, UserPlus, X, RefreshCw, FileSpreadsheet } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import { structureApi } from '../../api/structure';
import { useAuth } from '../../contexts/AuthContext';
import { EnrichPreviewModal } from '../../components/employees/EnrichPreviewModal';
import type { Employee, EmployeeInput, OrgDepartmentNode, IEmployeePresence, EnrichPreview } from '../../types';
import '../../styles/EmployeesPage.css';

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] || '?').toUpperCase();
};

const formatTime = (val: string): string => {
  if (val.includes('T')) return val.slice(11, 16);
  return val.slice(0, 5);
};

const collectChildIds = (node: OrgDepartmentNode): string[] => {
  const ids = [node.id];
  for (const child of node.children) ids.push(...collectChildIds(child));
  return ids;
};

const EmpVirtualList: FC<{
  employees: Employee[];
  loading: boolean;
  selectedEmps: Set<number>;
  presenceMap: Map<number, IEmployeePresence>;
  canEdit: boolean;
  onEmpClick: (emp: Employee) => void;
  onToggleSelection: (id: number, e: React.MouseEvent) => void;
  onFire: (emp: Employee, e: React.MouseEvent) => void;
  onRehire: (emp: Employee, e: React.MouseEvent) => void;
  onMove: (id: number, e: React.MouseEvent) => void;
}> = ({ employees, loading, selectedEmps, presenceMap, canEdit, onEmpClick, onToggleSelection, onFire, onRehire, onMove }) => {
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: employees.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 72,
    overscan: 10,
  });

  if (loading) return <div className="ep-emp-list"><div className="ep-loading">Загрузка...</div></div>;
  if (employees.length === 0) {
    return (
      <div className="ep-emp-list">
        <div className="ep-empty">
          <div className="ep-empty-icon"><Users size={28} /></div>
          <h3>Сотрудники не найдены</h3>
          <p>Попробуйте изменить фильтры или выбрать другой отдел</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ep-emp-list" ref={listRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vRow => {
          const emp = employees[vRow.index];
          return (
            <div
              key={emp.id}
              className={`ep-emp-card ${selectedEmps.has(emp.id) ? 'selected' : ''}`}
              onClick={() => onEmpClick(emp)}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vRow.start}px)` }}
            >
              <div
                className={`ep-emp-checkbox ${selectedEmps.has(emp.id) ? 'checked' : ''}`}
                onClick={e => onToggleSelection(emp.id, e)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="ep-emp-avatar">{getInitials(emp.full_name)}</div>
              <div className="ep-emp-info">
                <div className="ep-emp-name">
                  {emp.full_name}
                  {presenceMap.has(emp.id) && (
                    <span
                      className={`ep-emp-badge ${presenceMap.get(emp.id)!.status}`}
                      title={presenceMap.get(emp.id)!.status === 'online' ? 'На месте' : 'Отсутствует'}
                    />
                  )}
                </div>
                <div className="ep-emp-position">{emp.position_name || '—'}</div>
              </div>
              {emp.employment_status !== 'fired' && presenceMap.has(emp.id) && (
                <div className="ep-emp-meta">
                  {presenceMap.get(emp.id)!.total_hours != null && (
                    <div className="ep-emp-stat">
                      <span className="ep-emp-stat-value">
                        {presenceMap.get(emp.id)!.total_hours!.toFixed(1)}ч
                      </span>
                      <span className="ep-emp-stat-label">Сегодня</span>
                    </div>
                  )}
                  {presenceMap.get(emp.id)!.first_entry && (
                    <div className="ep-emp-stat">
                      <span className="ep-emp-stat-value">
                        {formatTime(presenceMap.get(emp.id)!.first_entry!)}
                      </span>
                      <span className="ep-emp-stat-label">Вход</span>
                    </div>
                  )}
                </div>
              )}
              {canEdit && emp.employment_status !== 'fired' && (
                <div className="ep-emp-actions">
                  <button className="ep-action-btn dismiss" onClick={e => onFire(emp, e)}>
                    Уволить
                  </button>
                  <button className="ep-action-btn move" onClick={e => onMove(emp.id, e)}>
                    Переместить
                  </button>
                </div>
              )}
              {emp.employment_status === 'fired' && (
                <div className="ep-emp-actions">
                  <button className="ep-action-btn move" onClick={e => onRehire(emp, e)}>
                    Восстановить
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const EmployeesPage: FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { canAccess } = useAuth();
  const canEdit = canAccess('header');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const enrichInputRef = useRef<HTMLInputElement>(null);

  // Data
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<OrgDepartmentNode[]>([]);
  const [presenceMap, setPresenceMap] = useState<Map<number, IEmployeePresence>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(searchParams.get('dept'));
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());
  const [deptSearch, setDeptSearch] = useState('');
  const [empSearch, setEmpSearch] = useState(searchParams.get('q') || '');
  const [activeTab, setActiveTab] = useState<'all' | 'fired'>('all');

  // Modals
  const [moveEmpId, setMoveEmpId] = useState<number | null>(null);
  const [moveDeptId, setMoveDeptValue] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [formData, setFormData] = useState<EmployeeInput>({
    full_name: '',
    hire_date: new Date().toISOString().split('T')[0],
  });

  // Enrich
  const [enrichPreview, setEnrichPreview] = useState<EnrichPreview | null>(null);
  const [enrichFile, setEnrichFile] = useState<File | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);

  // Selection
  const [selectedEmps, setSelectedEmps] = useState<Set<number>>(new Set());

  // URL sync
  useEffect(() => {
    const params = new URLSearchParams();
    if (empSearch) params.set('q', empSearch);
    if (selectedDeptId) params.set('dept', selectedDeptId);
    setSearchParams(params, { replace: true });
  }, [empSearch, selectedDeptId, setSearchParams]);

  // Load data
  const loadEmployees = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await employeeService.getAll({ view: 'list' });
      setEmployees(data);
    } catch {
      setError('Ошибка загрузки сотрудников');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDepartments = useCallback(async () => {
    try {
      const res = await structureApi.getTree();
      if (res.data?.departments) {
        setDepartments(res.data.departments);
        setExpandedDepts(new Set(res.data.departments.map(d => d.id)));
      }
    } catch { /* ignore */ }
  }, []);

  const loadPresence = useCallback(async (deptId: string | null) => {
    if (!deptId) {
      setPresenceMap(new Map());
      return;
    }
    try {
      const data = await skudService.getPresence(deptId);
      const map = new Map<number, IEmployeePresence>();
      data.forEach(p => map.set(p.employee_id, p));
      setPresenceMap(map);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadEmployees(); loadDepartments(); }, [loadEmployees, loadDepartments]);
  useEffect(() => { loadPresence(selectedDeptId); }, [selectedDeptId, loadPresence]);

  // Department employee counts
  const deptCounts = useMemo(() => {
    const direct = new Map<string, number>();
    employees
      .filter(e => e.employment_status !== 'fired')
      .forEach(emp => {
        if (emp.org_department_id) {
          direct.set(emp.org_department_id, (direct.get(emp.org_department_id) || 0) + 1);
        }
      });
    const totals = new Map<string, number>();
    const compute = (node: OrgDepartmentNode): number => {
      let count = direct.get(node.id) || 0;
      for (const child of node.children) count += compute(child);
      totals.set(node.id, count);
      return count;
    };
    departments.forEach(d => compute(d));
    return totals;
  }, [employees, departments]);

  // Selected department
  const selectedDeptInfo = useMemo(() => {
    if (!selectedDeptId) return null;
    const find = (nodes: OrgDepartmentNode[]): OrgDepartmentNode | null => {
      for (const n of nodes) {
        if (n.id === selectedDeptId) return n;
        const f = find(n.children);
        if (f) return f;
      }
      return null;
    };
    return find(departments);
  }, [selectedDeptId, departments]);

  const selectedDeptIds = useMemo(() => {
    if (!selectedDeptInfo) return null;
    return new Set(collectChildIds(selectedDeptInfo));
  }, [selectedDeptInfo]);

  // Filtered employees
  const filteredEmployees = useMemo(() => {
    return employees.filter(emp => {
      const matchesDept = !selectedDeptIds || selectedDeptIds.has(emp.org_department_id || '');
      const matchesSearch = !empSearch ||
        emp.full_name.toLowerCase().includes(empSearch.toLowerCase()) ||
        (emp.position_name || '').toLowerCase().includes(empSearch.toLowerCase());
      const matchesTab = activeTab === 'all'
        ? emp.employment_status !== 'fired'
        : emp.employment_status === 'fired';
      return matchesDept && matchesSearch && matchesTab;
    });
  }, [employees, selectedDeptIds, empSearch, activeTab]);

  // Tab counts
  const tabCounts = useMemo(() => {
    const deptFiltered = employees.filter(emp =>
      !selectedDeptIds || selectedDeptIds.has(emp.org_department_id || ''),
    );
    return {
      all: deptFiltered.filter(e => e.employment_status !== 'fired').length,
      fired: deptFiltered.filter(e => e.employment_status === 'fired').length,
    };
  }, [employees, selectedDeptIds]);

  // Flat departments for select
  const flatDepts = useMemo(() => {
    const result: { id: string; name: string; level: number }[] = [];
    const flatten = (nodes: OrgDepartmentNode[], level = 0) => {
      for (const n of nodes) {
        result.push({ id: n.id, name: n.name, level });
        flatten(n.children, level + 1);
      }
    };
    flatten(departments);
    return result;
  }, [departments]);

  // Filtered department tree
  const filteredDepts = useMemo(() => {
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
  }, [departments, deptSearch]);

  // Handlers
  const toggleDept = (id: string) => {
    setExpandedDepts(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleEmpClick = (emp: Employee) => navigate(`/tender/${emp.id}`);

  const handleFire = async (emp: Employee, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Уволить ${emp.full_name}?`)) return;
    try {
      await employeeService.fire(emp.id);
      loadEmployees();
    } catch { setError('Ошибка увольнения'); }
  };

  const handleRehire = async (emp: Employee, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await employeeService.rehire(emp.id);
      loadEmployees();
    } catch { setError('Ошибка восстановления'); }
  };

  const handleConfirmMove = async () => {
    if (!moveEmpId || !moveDeptId) return;
    try {
      await employeeService.moveDepartment(moveEmpId, moveDeptId);
      setMoveEmpId(null);
      loadEmployees();
    } catch { setError('Ошибка перемещения'); }
  };

  const handleAddEmployee = async () => {
    if (!formData.full_name || !formData.hire_date) return;
    try {
      await employeeService.create(formData);
      setShowAddModal(false);
      setFormData({ full_name: '', hire_date: new Date().toISOString().split('T')[0] });
      loadEmployees();
    } catch { setError('Ошибка добавления'); }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await employeeService.import(file);
      alert(`Импортировано: ${result.imported}`);
      loadEmployees();
    } catch { setError('Ошибка импорта'); }
    finally { e.target.value = ''; }
  };

  const handleEnrichUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setEnrichLoading(true);
      const preview = await employeeService.enrichPreview(file);
      setEnrichPreview(preview);
      setEnrichFile(file);
    } catch {
      setError('Ошибка чтения файла');
    } finally {
      setEnrichLoading(false);
      e.target.value = '';
    }
  };

  const handleEnrichApply = async () => {
    if (!enrichFile) return;
    try {
      setEnrichLoading(true);
      const result = await employeeService.enrichApply(enrichFile);
      setEnrichPreview(null);
      setEnrichFile(null);
      alert(`Обновлено: ${result.updated} сотрудников`);
      loadEmployees();
    } catch {
      setError('Ошибка обогащения данных');
    } finally {
      setEnrichLoading(false);
    }
  };

  const toggleEmpSelection = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedEmps(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Render department tree node
  const renderDeptNode = (node: OrgDepartmentNode, level = 0) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedDepts.has(node.id);
    const isSelected = selectedDeptId === node.id;
    const count = deptCounts.get(node.id) || 0;

    return (
      <div key={node.id} className="ep-dept-item">
        <div
          className={`ep-dept-header ${isSelected ? 'active' : ''}`}
          style={{ paddingLeft: `${12 + level * 20}px` }}
          onClick={() => setSelectedDeptId(isSelected ? null : node.id)}
        >
          <button
            className={`ep-dept-toggle ${hasChildren ? (isExpanded ? 'expanded' : '') : 'empty'}`}
            onClick={(e) => { e.stopPropagation(); toggleDept(node.id); }}
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

  const totalActive = employees.filter(e => e.employment_status !== 'fired').length;

  return (
    <div className="employees-page">
      {/* Department Panel */}
      <div className="ep-dept-panel">
        <div className="ep-dept-panel-header">
          <div className="ep-panel-title">
            <Folder size={16} />
            <span>Отделы</span>
          </div>
          <div className="ep-panel-actions">
            <button className="ep-panel-btn" onClick={loadDepartments} title="Обновить">
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
        <div className="ep-dept-search">
          <input
            type="text"
            placeholder="Поиск отдела..."
            value={deptSearch}
            onChange={e => setDeptSearch(e.target.value)}
          />
        </div>
        <div className="ep-dept-tree">
          <div
            className={`ep-dept-header ep-dept-all ${!selectedDeptId ? 'active' : ''}`}
            onClick={() => setSelectedDeptId(null)}
          >
            <Users size={16} className="ep-dept-icon" />
            <span className="ep-dept-name">Все сотрудники</span>
            <span className="ep-dept-count">{totalActive}</span>
          </div>
          {filteredDepts.map(dept => renderDeptNode(dept))}
        </div>
      </div>

      {/* Employees Panel */}
      <div className="ep-emp-panel">
        <div className="ep-emp-header">
          <div className="ep-emp-title">
            <h2>{selectedDeptInfo?.name || 'Все сотрудники'}</h2>
            <span className="ep-emp-count">{filteredEmployees.length} чел.</span>
          </div>
          <div className="ep-emp-tabs">
            <button
              className={`ep-tab ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              Все<span className="ep-tab-num">({tabCounts.all})</span>
            </button>
            <button
              className={`ep-tab ${activeTab === 'fired' ? 'active' : ''}`}
              onClick={() => setActiveTab('fired')}
            >
              Уволенные<span className="ep-tab-num">({tabCounts.fired})</span>
            </button>
          </div>
        </div>

        <div className="ep-emp-toolbar">
          <div className="ep-toolbar-search">
            <Search size={15} />
            <input
              type="text"
              placeholder="Поиск по имени..."
              value={empSearch}
              onChange={e => setEmpSearch(e.target.value)}
            />
          </div>
          {canEdit && (
            <div className="ep-toolbar-actions">
              <button className="ep-toolbar-btn secondary" onClick={() => enrichInputRef.current?.click()}>
                <FileSpreadsheet size={16} />
                <span>Импорт сотрудников</span>
              </button>
              <input ref={enrichInputRef} type="file" accept=".xlsx,.xls" onChange={handleEnrichUpload} hidden />
              <button className="ep-toolbar-btn secondary" onClick={() => fileInputRef.current?.click()}>
                <Upload size={16} />
                <span>Импорт</span>
              </button>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleImport} hidden />
              <button className="ep-toolbar-btn primary" onClick={() => setShowAddModal(true)}>
                <UserPlus size={16} />
                <span>Добавить</span>
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="ep-error">
            {error}
            <button onClick={() => setError('')}>×</button>
          </div>
        )}

        <EmpVirtualList
          employees={filteredEmployees}
          loading={loading}
          selectedEmps={selectedEmps}
          presenceMap={presenceMap}
          canEdit={canEdit}
          onEmpClick={handleEmpClick}
          onToggleSelection={toggleEmpSelection}
          onFire={handleFire}
          onRehire={handleRehire}
          onMove={(id, e) => { e.stopPropagation(); setMoveEmpId(id); setMoveDeptValue(''); }}
        />
      </div>

      {/* Move Department Modal */}
      {moveEmpId !== null && (
        <div className="ep-modal-overlay" onClick={() => setMoveEmpId(null)}>
          <div className="ep-modal" onClick={e => e.stopPropagation()}>
            <div className="ep-modal-header">
              <span className="ep-modal-title">Переместить в отдел</span>
              <button className="ep-modal-close" onClick={() => setMoveEmpId(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="ep-modal-body">
              <label>Выберите отдел</label>
              <select
                value={moveDeptId}
                onChange={e => setMoveDeptValue(e.target.value)}
                className="ep-modal-select"
              >
                <option value="">— Выберите —</option>
                {flatDepts.map(d => (
                  <option key={d.id} value={d.id}>
                    {'\u00A0\u00A0'.repeat(d.level)}{d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" onClick={() => setMoveEmpId(null)}>
                Отмена
              </button>
              <button
                className="ep-modal-btn primary"
                onClick={handleConfirmMove}
                disabled={!moveDeptId}
              >
                Переместить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enrich Preview Modal */}
      {enrichPreview && (
        <EnrichPreviewModal
          preview={enrichPreview}
          loading={enrichLoading}
          onApply={handleEnrichApply}
          onClose={() => { setEnrichPreview(null); setEnrichFile(null); }}
        />
      )}

      {/* Add Employee Modal */}
      {showAddModal && (
        <div className="ep-modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="ep-modal" onClick={e => e.stopPropagation()}>
            <div className="ep-modal-header">
              <span className="ep-modal-title">Добавить сотрудника</span>
              <button className="ep-modal-close" onClick={() => setShowAddModal(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="ep-modal-body">
              <label>ФИО</label>
              <input
                type="text"
                className="ep-modal-input"
                value={formData.full_name}
                onChange={e => setFormData({ ...formData, full_name: e.target.value })}
                placeholder="Иванов Иван Иванович"
              />
              <label style={{ marginTop: 12 }}>Дата найма</label>
              <input
                type="date"
                className="ep-modal-input"
                value={formData.hire_date}
                onChange={e => setFormData({ ...formData, hire_date: e.target.value })}
              />
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" onClick={() => setShowAddModal(false)}>
                Отмена
              </button>
              <button className="ep-modal-btn primary" onClick={handleAddEmployee}>
                Добавить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
