import { useState, useEffect, useCallback, useMemo, useRef, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Upload, UserPlus, X, FileSpreadsheet } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import { structureApi } from '../../api/structure';
import { useAuth } from '../../contexts/AuthContext';
import { EnrichPreviewModal } from '../../components/employees/EnrichPreviewModal';
import { EmpVirtualList } from '../../components/employees/EmpVirtualList';
import { DepartmentPanel } from '../../components/employees/DepartmentPanel';
import type { Employee, EmployeeInput, OrgDepartmentNode, IEmployeePresence, EnrichPreview } from '../../types';
import '../../styles/EmployeesPage.css';

const collectChildIds = (node: OrgDepartmentNode): string[] => {
  const ids = [node.id];
  for (const child of node.children) ids.push(...collectChildIds(child));
  return ids;
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

  const totalActive = employees.filter(e => e.employment_status !== 'fired').length;

  return (
    <div className="employees-page">
      <DepartmentPanel
        departments={departments}
        selectedDeptId={selectedDeptId}
        expandedDepts={expandedDepts}
        deptCounts={deptCounts}
        totalActive={totalActive}
        onSelectDept={setSelectedDeptId}
        onToggleDept={toggleDept}
        onRefresh={loadDepartments}
      />

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
