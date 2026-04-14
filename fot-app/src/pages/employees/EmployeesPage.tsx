import { useState, useEffect, useMemo, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { X, ChevronLeft, ChevronRight, FolderOpen, Search } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { useAuth } from '../../contexts/AuthContext';
import { EmpVirtualList } from '../../components/employees/EmpVirtualList';
import { DepartmentPanel } from '../../components/employees/DepartmentPanel';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { Employee, OrgDepartmentNode, IEmployeePresence } from '../../types';
import {
  EMPTY_EMPLOYEE_COUNTS,
  EMPTY_PAGINATED_META,
  EMPTY_PAGINATED_RESPONSE,
  useEmployeeCountsQuery,
  usePaginatedEmployeesQuery,
  usePresenceQuery,
} from '../../hooks/useEmployeeDirectory';
import { useStructureTree } from '../../hooks/useStructure';
import { getSortedFlatDepartments } from '../../utils/departmentUtils';
import '../../styles/EmployeesPage.css';

const PAGE_SIZE = 50;
const EMPTY_DEPARTMENTS: OrgDepartmentNode[] = [];

export const EmployeesPage: FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { canEditPage, hasPermission, profile } = useAuth();
  const isMobile = useIsMobile(768);
  const canEdit = canEditPage('/employees') || canEditPage('/staff-control');
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
  const initialPage = Number.parseInt(searchParams.get('page') || '1', 10);

  const [error, setError] = useState('');
  const [page, setPage] = useState(Number.isFinite(initialPage) && initialPage > 0 ? initialPage : 1);

  // Filters
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(searchParams.get('dept'));
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());
  const [unifiedSearch, setUnifiedSearch] = useState(searchParams.get('q') || '');
  const [debouncedSearch, setDebouncedSearch] = useState(unifiedSearch);
  const [activeTab, setActiveTab] = useState<'all' | 'fired'>(searchParams.get('tab') === 'fired' ? 'fired' : 'all');
  const [isDeptPanelOpen, setIsDeptPanelOpen] = useState(false);

  // Modals
  const [moveEmpId, setMoveEmpId] = useState<number | null>(null);
  const [moveDeptId, setMoveDeptValue] = useState('');

  // Selection
  const [selectedEmps, setSelectedEmps] = useState<Set<number>>(new Set());

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(unifiedSearch);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [unifiedSearch]);

  // URL sync
  useEffect(() => {
    const params = new URLSearchParams();
    if (unifiedSearch) params.set('q', unifiedSearch);
    if (!isDepartmentScope && selectedDeptId) params.set('dept', selectedDeptId);
    if (activeTab !== 'all') params.set('tab', activeTab);
    if (page > 1) params.set('page', String(page));
    setSearchParams(params, { replace: true });
  }, [activeTab, isDepartmentScope, page, unifiedSearch, selectedDeptId, setSearchParams]);

  useEffect(() => {
    if (isDepartmentScope) {
      setIsDeptPanelOpen(false);
    }
  }, [isDepartmentScope]);

  // Resolve department_id for server (selected dept + children for header filtering)
  const serverDeptId = useMemo(() => {
    // Для department-scope всегда работаем в рамках отдела пользователя.
    // Для серверной пагинации передаём только выбранный отдел.
    // Дочерние отделы будут включены, т.к. backend фильтрует по org_department_id
    if (isDepartmentScope) {
      return profile?.department_id || undefined;
    }

    return selectedDeptId || undefined;
  }, [isDepartmentScope, profile?.department_id, selectedDeptId]);

  const structureQuery = useStructureTree(!isDepartmentScope);
  const departments = isDepartmentScope
    ? EMPTY_DEPARTMENTS
    : structureQuery.data?.departments ?? EMPTY_DEPARTMENTS;

  // Detect if query matches any department name (dept-search mode)
  const matchesDept = useMemo(() => {
    if (!debouncedSearch) return false;
    const q = debouncedSearch.toLowerCase();
    const check = (nodes: OrgDepartmentNode[]): boolean =>
      nodes.some(n => n.name.toLowerCase().includes(q) || check(n.children));
    return check(departments);
  }, [debouncedSearch, departments]);

  const employeesQuery = usePaginatedEmployeesQuery({
    page,
    pageSize: PAGE_SIZE,
    search: (!matchesDept && debouncedSearch) ? debouncedSearch : undefined,
    status: activeTab === 'fired' ? 'fired' : 'active',
    departmentId: serverDeptId,
  });
  const countsQuery = useEmployeeCountsQuery(false);
  const presenceQuery = usePresenceQuery(serverDeptId ?? null, {
    enabled: activeTab !== 'fired',
    refetchInterval: activeTab === 'fired' ? false : 30_000,
  });
  const employees = (employeesQuery.data || EMPTY_PAGINATED_RESPONSE).data;
  const meta = (employeesQuery.data || EMPTY_PAGINATED_RESPONSE).meta || EMPTY_PAGINATED_META;
  const counts = countsQuery.data || EMPTY_EMPLOYEE_COUNTS;
  const loading = employeesQuery.isPending || countsQuery.isPending || (!isDepartmentScope && structureQuery.isPending);
  const queryError = employeesQuery.isError
    ? 'Ошибка загрузки сотрудников'
    : (!isDepartmentScope && structureQuery.isError)
      ? 'Ошибка загрузки структуры'
      : countsQuery.isError
        ? 'Ошибка загрузки сотрудников'
        : '';
  const visibleError = error || queryError;
  const refetchPresence = presenceQuery.refetch;
  const presenceMap = useMemo(() => {
    if (activeTab === 'fired') return new Map<number, IEmployeePresence>();
    const map = new Map<number, IEmployeePresence>();
    (presenceQuery.data || []).forEach(presence => map.set(presence.employee_id, presence));
    return map;
  }, [activeTab, presenceQuery.data]);

  useEffect(() => {
    if (activeTab === 'fired') {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refetchPresence();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeTab, refetchPresence]);

  // Highlight departments of found employees when in employee-search mode
  const highlightedDeptIds = useMemo(() => {
    if (!debouncedSearch || matchesDept) return new Set<string>();
    const ids = new Set<string>();
    for (const emp of employees) {
      if (emp.org_department_id) ids.add(emp.org_department_id);
    }
    return ids;
  }, [debouncedSearch, matchesDept, employees]);

  const effectiveExpandedDepts = useMemo(() => {
    if (!debouncedSearch || highlightedDeptIds.size === 0 || departments.length === 0) {
      return expandedDepts;
    }
    const flatMap = new Map<string, OrgDepartmentNode>();
    const walk = (nodes: OrgDepartmentNode[]) => {
      for (const n of nodes) { flatMap.set(n.id, n); walk(n.children); }
    };
    walk(departments);
    const toExpand = new Set<string>();
    for (const deptId of highlightedDeptIds) {
      let node = flatMap.get(deptId);
      while (node) {
        toExpand.add(node.id);
        node = node.parent_id ? flatMap.get(node.parent_id) : undefined;
      }
    }
    const next = new Set(expandedDepts);
    for (const id of toExpand) next.add(id);
    return next;
  }, [debouncedSearch, departments, expandedDepts, highlightedDeptIds]);

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
    return getSortedFlatDepartments(departments);
  }, [departments]);
  const employeeCardBackState = useMemo(() => {
    const params = new URLSearchParams();
    if (unifiedSearch) params.set('q', unifiedSearch);
    if (!isDepartmentScope && selectedDeptId) params.set('dept', selectedDeptId);
    if (activeTab !== 'all') params.set('tab', activeTab);
    if (page > 1) params.set('page', String(page));
    const query = params.toString();
    return {
      label: 'Сотрудники',
      from: `/employees${query ? `?${query}` : ''}`,
    };
  }, [activeTab, isDepartmentScope, page, unifiedSearch, selectedDeptId]);

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

  const handleEmpClick = (emp: Employee) => {
    if (isMobile) setIsDeptPanelOpen(false);
    navigate(`/employees/${emp.id}`, { state: employeeCardBackState });
  };

  const refetchDirectory = async () => {
    await Promise.all([
      employeesQuery.refetch(),
      countsQuery.refetch(),
      activeTab === 'fired' ? Promise.resolve() : presenceQuery.refetch(),
    ]);
  };

  const handleRefreshDepartments = () => {
    void Promise.all([
      structureQuery.refetch(),
      countsQuery.refetch(),
    ]);
  };

  const handleFire = async (emp: Employee, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Уволить ${emp.full_name}?`)) return;
    try {
      await employeeService.fire(emp.id);
      await refetchDirectory();
    } catch { setError('Ошибка увольнения'); }
  };

  const handleRehire = async (emp: Employee, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await employeeService.rehire(emp.id);
      await refetchDirectory();
    } catch { setError('Ошибка восстановления'); }
  };

  const handleConfirmMove = async () => {
    if (!moveEmpId || !moveDeptId) return;
    try {
      await employeeService.moveDepartment(moveEmpId, moveDeptId);
      setMoveEmpId(null);
      await refetchDirectory();
    } catch { setError('Ошибка перемещения'); }
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
  const selectedDeptLabel = isDepartmentScope
    ? employees.find(emp => emp.department)?.department || 'Сотрудники'
    : selectedDeptInfo?.name || 'Все сотрудники';
  const departmentPanelNode = !isDepartmentScope ? (
    <DepartmentPanel
      departments={departments}
      selectedDeptId={selectedDeptId}
      expandedDepts={effectiveExpandedDepts}
      deptCounts={deptCounts}
      totalActive={totalActive}
      highlightedDeptIds={highlightedDeptIds}
      deptSearch={matchesDept ? unifiedSearch : ''}
      visibleDeptIds={(!matchesDept && debouncedSearch) ? highlightedDeptIds : undefined}
      searchValue={unifiedSearch}
      onSearchChange={setUnifiedSearch}
      onSelectDept={(deptId) => {
        setSelectedDeptId(deptId);
        setPage(1);
        if (isMobile) setIsDeptPanelOpen(false);
      }}
      onToggleDept={toggleDept}
      onRefresh={handleRefreshDepartments}
    />
  ) : null;

  return (
    <div className="employees-page">
      {!isDepartmentScope && isMobile ? (
        <>
          <div
            className={`ep-dept-mobile-overlay ${isDeptPanelOpen ? 'open' : ''}`}
            onClick={() => setIsDeptPanelOpen(false)}
          />
          <div className={`ep-dept-mobile-sheet ${isDeptPanelOpen ? 'open' : ''}`}>
            {departmentPanelNode}
          </div>
        </>
      ) : !isDepartmentScope ? (
        departmentPanelNode
      ) : null}

      {/* Employees Panel */}
      <div className="ep-emp-panel">
        <div className="ep-emp-header">
          <div className="ep-emp-head-main">
            {isMobile && !isDepartmentScope && (
              <button
                className="ep-mobile-filter-btn"
                onClick={() => setIsDeptPanelOpen(true)}
              >
                <FolderOpen size={16} />
                <span className="ep-mobile-filter-label">{selectedDeptLabel}</span>
              </button>
            )}
            <div className="ep-emp-title">
              <h2>{selectedDeptLabel}</h2>
              <span className="ep-emp-count">{meta.total} чел.</span>
            </div>
          </div>
          <div className="ep-emp-tabs">
            <button
                className={`ep-tab ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('all');
                setPage(1);
              }}
            >
              Все<span className="ep-tab-num">({tabCounts.active})</span>
            </button>
            <button
              className={`ep-tab ${activeTab === 'fired' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('fired');
                setPage(1);
              }}
            >
              Уволенные<span className="ep-tab-num">({tabCounts.fired})</span>
            </button>
          </div>
        </div>

        {isDepartmentScope && (
          <div className="ep-emp-toolbar">
            <div className="ep-toolbar-search">
              <Search size={14} />
              <input
                type="text"
                value={unifiedSearch}
                onChange={(e) => setUnifiedSearch(e.target.value)}
                placeholder="Поиск по сотруднику..."
              />
              {unifiedSearch && (
                <button className="ep-search-clear" onClick={() => setUnifiedSearch('')}>
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        )}

        {visibleError && (
          <div className="ep-error">
            {visibleError}
            {error && <button onClick={() => setError('')}>×</button>}
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

    </div>
  );
};
