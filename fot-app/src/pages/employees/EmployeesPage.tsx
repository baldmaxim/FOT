import { useState, useEffect, useCallback, useMemo, useRef, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, UserPlus, X, FileSpreadsheet, ChevronLeft, ChevronRight } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import type { PaginatedMeta, EmployeeCounts } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import { structureApi } from '../../api/structure';
import { useAuth } from '../../contexts/AuthContext';
import { EnrichPreviewModal } from '../../components/employees/EnrichPreviewModal';
import { EmpVirtualList } from '../../components/employees/EmpVirtualList';
import { DepartmentPanel } from '../../components/employees/DepartmentPanel';
import type { Employee, EmployeeInput, OrgDepartmentNode, IEmployeePresence, EnrichPreview } from '../../types';
import '../../styles/EmployeesPage.css';

const PAGE_SIZE = 50;

export const EmployeesPage: FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { canAccess } = useAuth();
  const canEdit = canAccess('header');
  const enrichInputRef = useRef<HTMLInputElement>(null);

  // Data
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<OrgDepartmentNode[]>([]);
  const [presenceMap, setPresenceMap] = useState<Map<number, IEmployeePresence>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Pagination & server filters
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState<PaginatedMeta>({ page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 });
  const [counts, setCounts] = useState<EmployeeCounts>({ byDepartment: {}, byStatus: { active: 0, fired: 0 } });

  // Filters
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(searchParams.get('dept'));
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());
  const [empSearch, setEmpSearch] = useState(searchParams.get('q') || '');
  const [debouncedSearch, setDebouncedSearch] = useState(empSearch);
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

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(empSearch);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [empSearch]);

  // URL sync
  useEffect(() => {
    const params = new URLSearchParams();
    if (empSearch) params.set('q', empSearch);
    if (selectedDeptId) params.set('dept', selectedDeptId);
    setSearchParams(params, { replace: true });
  }, [empSearch, selectedDeptId, setSearchParams]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [selectedDeptId, activeTab]);

  // Resolve department_id for server (selected dept + children for header filtering)
  const serverDeptId = useMemo(() => {
    // Для серверной пагинации передаём только выбранный отдел
    // Дочерние отделы будут включены, т.к. backend фильтрует по org_department_id
    return selectedDeptId || undefined;
  }, [selectedDeptId]);

  // Load paginated data
  const loadPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await employeeService.getPaginated({
        page,
        pageSize: PAGE_SIZE,
        search: debouncedSearch || undefined,
        status: activeTab === 'fired' ? 'fired' : 'active',
        departmentId: serverDeptId,
      });
      setEmployees(result.data);
      setMeta(result.meta);
      setCounts(result.counts);
    } catch {
      setError('Ошибка загрузки сотрудников');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, activeTab, serverDeptId]);

  const loadDepartments = useCallback(async () => {
    try {
      const res = await structureApi.getTree();
      if (res.data?.departments) {
        setDepartments(res.data.departments);
        setExpandedDepts(new Set(res.data.departments.map(d => d.id)));
      }
    } catch { /* ignore */ }
  }, []);

  const loadPresence = useCallback(async () => {
    try {
      const data = await skudService.getPresence(selectedDeptId ?? undefined);
      const map = new Map<number, IEmployeePresence>();
      data.forEach(p => map.set(p.employee_id, p));
      setPresenceMap(map);
    } catch { /* ignore */ }
  }, [selectedDeptId]);

  useEffect(() => { loadPage(); }, [loadPage]);
  useEffect(() => { loadDepartments(); }, [loadDepartments]);
  useEffect(() => {
    loadPresence();
    const interval = setInterval(loadPresence, 30_000);
    return () => clearInterval(interval);
  }, [loadPresence]);

  // Department employee counts from server
  const deptCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [id, count] of Object.entries(counts.byDepartment)) {
      map.set(id, count);
    }
    // Compute totals for parent departments (include children)
    const totals = new Map<string, number>();
    const compute = (node: OrgDepartmentNode): number => {
      let count = map.get(node.id) || 0;
      for (const child of node.children) count += compute(child);
      totals.set(node.id, count);
      return count;
    };
    departments.forEach(d => compute(d));
    return totals;
  }, [counts.byDepartment, departments]);

  const tabCounts = useMemo(() => counts.byStatus, [counts.byStatus]);
  const totalActive = counts.byStatus.active;

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

  // Selected department info
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

  // Handlers
  const toggleDept = (id: string) => {
    setExpandedDepts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleEmpClick = (emp: Employee) => navigate(`/tender/${emp.id}`);

  const handleFire = async (emp: Employee, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Уволить ${emp.full_name}?`)) return;
    try {
      await employeeService.fire(emp.id);
      loadPage();
    } catch { setError('Ошибка увольнения'); }
  };

  const handleRehire = async (emp: Employee, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await employeeService.rehire(emp.id);
      loadPage();
    } catch { setError('Ошибка восстановления'); }
  };

  const handleConfirmMove = async () => {
    if (!moveEmpId || !moveDeptId) return;
    try {
      await employeeService.moveDepartment(moveEmpId, moveDeptId);
      setMoveEmpId(null);
      loadPage();
    } catch { setError('Ошибка перемещения'); }
  };

  const handleAddEmployee = async () => {
    if (!formData.full_name || !formData.hire_date) return;
    try {
      await employeeService.create(formData);
      setShowAddModal(false);
      setFormData({ full_name: '', hire_date: new Date().toISOString().split('T')[0] });
      loadPage();
    } catch { setError('Ошибка добавления'); }
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

  const handleEnrichApply = async (manualMatches: Array<{ fullName: string; employeeId: number }> = []) => {
    if (!enrichFile) return;
    try {
      setEnrichLoading(true);
      const result = await employeeService.enrichApply(enrichFile, manualMatches);
      alert(`Обновлено: ${result.updated} сотрудников`);
      loadPage();
    } catch {
      setError('Ошибка обогащения данных');
    } finally {
      setEnrichLoading(false);
      setEnrichPreview(null);
      setEnrichFile(null);
    }
  };

  const toggleEmpSelection = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedEmps(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Pagination helpers
  const canPrev = page > 1;
  const canNext = page < meta.totalPages;

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
            <span className="ep-emp-count">{meta.total} чел.</span>
          </div>
          <div className="ep-emp-tabs">
            <button
              className={`ep-tab ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              Все<span className="ep-tab-num">({tabCounts.active})</span>
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
          employees={employees}
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

        {/* Pagination */}
        {meta.totalPages > 1 && (
          <div className="ep-pagination">
            <button
              className="ep-pagination-btn"
              disabled={!canPrev}
              onClick={() => setPage(p => p - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="ep-pagination-info">
              {meta.page} / {meta.totalPages}
            </span>
            <button
              className="ep-pagination-btn"
              disabled={!canNext}
              onClick={() => setPage(p => p + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
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
