import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  MoveRight,
  Search,
  ShieldCheck,
  UserRoundX,
  X,
} from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { structureApi } from '../../api/structure';
import { useAuth } from '../../contexts/AuthContext';
import { EmpVirtualList } from '../../components/employees/EmpVirtualList';
import { DepartmentPanel } from '../../components/employees/DepartmentPanel';
import { EmployeeSigurSidebar } from '../../components/employees/EmployeeSigurSidebar';
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
import { usePresenceRealtime } from '../../hooks/usePresenceRealtime';
import { useStructureTree } from '../../hooks/useStructure';
import { getSortedFlatDepartments } from '../../utils/departmentUtils';
import '../../styles/EmployeesPage.css';

const PAGE_SIZE = 50;
const EMPTY_DEPARTMENTS: OrgDepartmentNode[] = [];

type DepartmentDialogState =
  | { mode: 'create'; parentId: string | null; name: string; description: string }
  | { mode: 'rename'; departmentId: string; name: string }
  | { mode: 'move'; departmentIds: string[]; parentId: string | null }
  | { mode: 'delete'; departmentIds: string[] }
  | { mode: 'deleteRecursive'; departmentId: string }
  | null;

const walkDepartmentTree = (nodes: OrgDepartmentNode[], cb: (node: OrgDepartmentNode) => void): void => {
  for (const node of nodes) {
    cb(node);
    walkDepartmentTree(node.children, cb);
  }
};

export const EmployeesPage: FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { canEditPage, canViewPage, hasPermission, profile } = useAuth();
  const isMobile = useIsMobile(768);

  const canEdit = canEditPage('/employees') || canEditPage('/staff-control');
  const canManageStructure = canEditPage('/employees/structure-manage');
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
  const initialPage = Number.parseInt(searchParams.get('page') || '1', 10);

  const [error, setError] = useState('');
  const [page, setPage] = useState(Number.isFinite(initialPage) && initialPage > 0 ? initialPage : 1);
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(searchParams.get('dept'));
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());
  const [unifiedSearch, setUnifiedSearch] = useState(searchParams.get('q') || '');
  const [debouncedSearch, setDebouncedSearch] = useState(unifiedSearch);
  const [lastActiveDeptId, setLastActiveDeptId] = useState<string | null>(
    searchParams.get('dept') || null,
  );
  const [isDeptPanelOpen, setIsDeptPanelOpen] = useState(false);
  const [selectedEmps, setSelectedEmps] = useState<Set<number>>(new Set());
  const [selectedManageDeptIds, setSelectedManageDeptIds] = useState<Set<string>>(new Set());
  const [moveEmployeeIds, setMoveEmployeeIds] = useState<number[]>([]);
  const [moveDeptId, setMoveDeptId] = useState('');
  const [rehireEmployee, setRehireEmployee] = useState<Employee | null>(null);
  const [rehireDeptId, setRehireDeptId] = useState('');
  const [rehireInFlight, setRehireInFlight] = useState(false);
  const [editingEmployeeId, setEditingEmployeeId] = useState<number | null>(null);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [departmentDialog, setDepartmentDialog] = useState<DepartmentDialogState>(null);
  const [isDepartmentActionRunning, setIsDepartmentActionRunning] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(unifiedSearch);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [unifiedSearch]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (unifiedSearch) params.set('q', unifiedSearch);
    if (!isDepartmentScope && selectedDeptId) params.set('dept', selectedDeptId);
    if (page > 1) params.set('page', String(page));
    setSearchParams(params, { replace: true });
  }, [isDepartmentScope, page, selectedDeptId, setSearchParams, unifiedSearch]);

  useEffect(() => {
    if (isDepartmentScope) {
      setIsDeptPanelOpen(false);
    }
  }, [isDepartmentScope]);

  const serverDeptId = useMemo(() => {
    if (isDepartmentScope) {
      return profile?.department_id || undefined;
    }
    return selectedDeptId || undefined;
  }, [isDepartmentScope, profile?.department_id, selectedDeptId]);

  const structureQuery = useStructureTree(!isDepartmentScope);
  const departments = isDepartmentScope
    ? EMPTY_DEPARTMENTS
    : structureQuery.data?.departments ?? EMPTY_DEPARTMENTS;
  const archiveDepartmentId = isDepartmentScope
    ? null
    : structureQuery.data?.stats.archive_department_id || null;
  const isArchiveView = !!archiveDepartmentId && selectedDeptId === archiveDepartmentId;
  const normalizedSearch = debouncedSearch.trim();
  const flatDepts = useMemo(() => getSortedFlatDepartments(departments), [departments]);
  const departmentSearchMatches = useMemo(() => {
    if (!normalizedSearch) return [];
    const query = normalizedSearch.toLowerCase();
    return flatDepts.filter(department => department.name.toLowerCase().includes(query));
  }, [flatDepts, normalizedSearch]);
  const hasDepartmentSearchMatches = !isDepartmentScope && departmentSearchMatches.length > 0;
  const employeeSearchValue = normalizedSearch && !hasDepartmentSearchMatches ? normalizedSearch : undefined;

  useEffect(() => {
    if (selectedDeptId && selectedDeptId !== archiveDepartmentId) {
      setLastActiveDeptId(selectedDeptId);
    }
  }, [archiveDepartmentId, selectedDeptId]);

  const employeesQuery = usePaginatedEmployeesQuery({
    page,
    pageSize: PAGE_SIZE,
    search: employeeSearchValue,
    status: isArchiveView ? 'fired' : 'active',
    departmentId: serverDeptId,
  });
  const countsQuery = useEmployeeCountsQuery(false);
  const presenceQuery = usePresenceQuery(serverDeptId ?? null, {
    enabled: !isArchiveView,
    refetchInterval: isArchiveView ? false : 120_000,
  });
  const refreshPresence = useCallback(() => {
    if (isArchiveView) return;
    void presenceQuery.refetch();
  }, [isArchiveView, presenceQuery]);

  usePresenceRealtime({
    enabled: !isArchiveView,
    owner: 'employees-presence',
    onPresenceUpdate: refreshPresence,
    onVisible: refreshPresence,
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
  const presenceMap = useMemo(() => {
    if (isArchiveView) return new Map<number, IEmployeePresence>();
    const map = new Map<number, IEmployeePresence>();
    (presenceQuery.data || []).forEach(presence => map.set(presence.employee_id, presence));
    return map;
  }, [isArchiveView, presenceQuery.data]);

  const highlightedDeptIds = useMemo(() => {
    if (!employeeSearchValue) return new Set<string>();
    const ids = new Set<string>();
    for (const employee of employees) {
      if (employee.org_department_id) ids.add(employee.org_department_id);
    }
    return ids;
  }, [employeeSearchValue, employees]);

  const effectiveExpandedDepts = useMemo(() => {
    if (!employeeSearchValue || highlightedDeptIds.size === 0 || departments.length === 0) {
      return expandedDepts;
    }
    const flatMap = new Map<string, OrgDepartmentNode>();
    walkDepartmentTree(departments, node => {
      flatMap.set(node.id, node);
    });

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
  }, [departments, employeeSearchValue, expandedDepts, highlightedDeptIds]);

  const deptCounts = useMemo(() => {
    const baseCounts = new Map<string, number>();
    for (const [id, count] of Object.entries(counts.byDepartment)) {
      baseCounts.set(id, count);
    }

    const totals = new Map<string, number>();
    const compute = (node: OrgDepartmentNode): number => {
      let count = baseCounts.get(node.id) || 0;
      for (const child of node.children) count += compute(child);
      totals.set(node.id, count);
      return count;
    };

    departments.forEach(department => compute(department));
    if (archiveDepartmentId) {
      totals.set(archiveDepartmentId, counts.byStatus.fired);
    }
    return totals;
  }, [archiveDepartmentId, counts.byDepartment, counts.byStatus.fired, departments]);

  const moveTargetDepartments = useMemo(
    () => flatDepts.filter(department => department.id !== archiveDepartmentId),
    [archiveDepartmentId, flatDepts],
  );
  const selectedDeptInfo = useMemo(() => {
    if (!selectedDeptId) return null;
    const find = (nodes: OrgDepartmentNode[]): OrgDepartmentNode | null => {
      for (const node of nodes) {
        if (node.id === selectedDeptId) return node;
        const childMatch = find(node.children);
        if (childMatch) return childMatch;
      }
      return null;
    };
    return find(departments);
  }, [departments, selectedDeptId]);

  useEffect(() => {
    if (isDepartmentScope || !hasDepartmentSearchMatches) {
      return;
    }

    if (selectedDeptId && departmentSearchMatches.some(department => department.id === selectedDeptId)) {
      return;
    }

    setSelectedDeptId(departmentSearchMatches[0].id);
    setPage(1);
  }, [departmentSearchMatches, hasDepartmentSearchMatches, isDepartmentScope, selectedDeptId]);

  const selectedDeptLabel = isDepartmentScope
    ? employees.find(employee => employee.department)?.department || 'Сотрудники'
    : selectedDeptInfo?.name || 'Все сотрудники';
  const selectedCountLabel = isArchiveView ? counts.byStatus.fired : meta.total;

  const employeeCardBackState = useMemo(() => {
    const params = new URLSearchParams();
    if (unifiedSearch) params.set('q', unifiedSearch);
    if (!isDepartmentScope && selectedDeptId) params.set('dept', selectedDeptId);
    if (page > 1) params.set('page', String(page));
    const query = params.toString();
    return {
      label: 'Сотрудники',
      from: `/employees${query ? `?${query}` : ''}`,
    };
  }, [isDepartmentScope, page, selectedDeptId, unifiedSearch]);

  const openFullEmployeeCard = useCallback((employeeId: number) => {
    if (isMobile) setIsDeptPanelOpen(false);
    navigate(`/employees/${employeeId}`, { state: employeeCardBackState });
  }, [employeeCardBackState, isMobile, navigate]);

  const refetchDirectory = async () => {
    await Promise.all([
      employeesQuery.refetch(),
      countsQuery.refetch(),
      isArchiveView ? Promise.resolve() : presenceQuery.refetch(),
    ]);
  };

  const refetchStructureAndDirectory = async () => {
    await Promise.all([
      structureQuery.refetch(),
      refetchDirectory(),
    ]);
  };

  const resetEmployeeEditor = () => {
    setEditingEmployeeId(null);
    setEditingEmployee(null);
  };

  const allVisibleSelected = employees.length > 0 && employees.every(employee => selectedEmps.has(employee.id));

  const toggleVisibleEmployeesSelection = () => {
    setSelectedEmps(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        employees.forEach(employee => next.delete(employee.id));
      } else {
        employees.forEach(employee => next.add(employee.id));
      }
      return next;
    });
  };

  const showArchiveEmployees = () => {
    if (archiveDepartmentId) {
      setSelectedDeptId(archiveDepartmentId);
      setPage(1);
    }
  };

  const showActiveEmployees = () => {
    setSelectedDeptId(lastActiveDeptId && lastActiveDeptId !== archiveDepartmentId ? lastActiveDeptId : null);
    setPage(1);
  };

  const toggleDept = (id: string) => {
    setExpandedDepts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleEmpSelection = (id: number) => {
    setSelectedEmps(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleManageDeptSelection = (id: string) => {
    setSelectedManageDeptIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openEmployeeEditor = (employee: Employee) => {
    setEditingEmployeeId(employee.id);
    setEditingEmployee(employee);
    if (isMobile) setIsDeptPanelOpen(false);
  };

  const handleEmpClick = (employee: Employee) => {
    openEmployeeEditor(employee);
  };

  const fireEmployee = async (employee: Employee) => {
    try {
      await employeeService.fire(employee.id);
      if (editingEmployeeId === employee.id) resetEmployeeEditor();
      await refetchDirectory();
    } catch {
      setError('Ошибка увольнения');
    }
  };

  const handleFireFromSidebar = (employee: Employee) => {
    if (!confirm(`Уволить ${employee.full_name}?`)) return;
    void fireEmployee(employee);
  };

  const handleRehireFromSidebar = (employee: Employee) => {
    setRehireEmployee(employee);
    setRehireDeptId('');
  };

  const closeRehireModal = () => {
    setRehireEmployee(null);
    setRehireDeptId('');
  };

  const handleConfirmRehire = async () => {
    if (!rehireEmployee || !rehireDeptId) return;
    setRehireInFlight(true);
    try {
      await employeeService.rehire(rehireEmployee.id, rehireDeptId);
      const rehiredId = rehireEmployee.id;
      closeRehireModal();
      if (editingEmployeeId === rehiredId) resetEmployeeEditor();
      await refetchDirectory();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Ошибка восстановления');
    } finally {
      setRehireInFlight(false);
    }
  };

  const openMoveModal = (employeeIds: number[]) => {
    if (employeeIds.length === 0) return;
    setMoveEmployeeIds(employeeIds);
    setMoveDeptId('');
  };

  const handleConfirmMove = async () => {
    if (moveEmployeeIds.length === 0 || !moveDeptId) return;
    try {
      if (moveEmployeeIds.length === 1) {
        await employeeService.moveDepartment(moveEmployeeIds[0], moveDeptId);
      } else {
        const result = await employeeService.batchMove(moveEmployeeIds, moveDeptId);
        if (result.failed_count > 0) {
          setError(result.failures[0]?.error || 'Не всех сотрудников удалось переместить');
        }
      }
      setMoveEmployeeIds([]);
      setMoveDeptId('');
      setSelectedEmps(new Set());
      await refetchDirectory();
    } catch {
      setError('Ошибка перемещения');
    }
  };

  const handleDropEmployees = async (departmentId: string, employeeIds: number[]) => {
    try {
      if (employeeIds.length === 1) {
        await employeeService.moveDepartment(employeeIds[0], departmentId);
      } else {
        const result = await employeeService.batchMove(employeeIds, departmentId);
        if (result.failed_count > 0) {
          setError(result.failures[0]?.error || 'Не всех сотрудников удалось переместить');
        }
      }
      setSelectedEmps(new Set());
      await refetchDirectory();
    } catch {
      setError('Ошибка перемещения');
    }
  };

  const handleDepartmentAction = async () => {
    if (!departmentDialog) return;
    setIsDepartmentActionRunning(true);
    setError('');

    try {
      if (departmentDialog.mode === 'create') {
        const result = await structureApi.createDepartment(
          departmentDialog.name,
          departmentDialog.description || undefined,
          departmentDialog.parentId,
        );
        if (result.error) throw new Error(result.error);
      }

      if (departmentDialog.mode === 'rename') {
        const result = await structureApi.updateDepartment(departmentDialog.departmentId, {
          name: departmentDialog.name,
        });
        if (result.error) throw new Error(result.error);
      }

      if (departmentDialog.mode === 'move') {
        const result = await structureApi.batchMoveDepartments(
          departmentDialog.departmentIds,
          departmentDialog.parentId,
        );
        if (result.error) throw new Error(result.error);
      }

      if (departmentDialog.mode === 'delete') {
        for (const departmentId of departmentDialog.departmentIds) {
          const result = await structureApi.deleteDepartment(departmentId);
          if (result.error) throw new Error(result.error);
        }
      }

      if (departmentDialog.mode === 'deleteRecursive') {
        const result = await structureApi.deleteDepartmentRecursive(departmentDialog.departmentId);
        if (result.error) throw new Error(result.error);
        if (selectedDeptId === departmentDialog.departmentId) {
          setSelectedDeptId(result.data?.target_parent_id || null);
        }
      }

      setDepartmentDialog(null);
      setSelectedManageDeptIds(new Set());
      await refetchStructureAndDirectory();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Ошибка изменения структуры');
    } finally {
      setIsDepartmentActionRunning(false);
    }
  };

  const canPrev = page > 1;
  const canNext = page < meta.totalPages;

  const departmentPanelNode = !isDepartmentScope ? (
    <DepartmentPanel
      departments={departments}
      selectedDeptId={selectedDeptId}
      expandedDepts={effectiveExpandedDepts}
      deptCounts={deptCounts}
      totalActive={counts.byStatus.active}
      archiveDepartmentId={archiveDepartmentId}
      highlightedDeptIds={highlightedDeptIds}
      deptSearch={hasDepartmentSearchMatches ? normalizedSearch : ''}
      visibleDeptIds={employeeSearchValue ? highlightedDeptIds : undefined}
      canManage={canManageStructure}
      selectedManageDeptIds={selectedManageDeptIds}
      onSelectDept={(deptId) => {
        setSelectedDeptId(deptId);
        setPage(1);
        if (isMobile) setIsDeptPanelOpen(false);
      }}
      onToggleDept={toggleDept}
      onRefresh={() => { void refetchStructureAndDirectory(); }}
      onToggleManageSelection={toggleManageDeptSelection}
      onSetManageSelection={(departmentIds) => setSelectedManageDeptIds(new Set(departmentIds))}
      onClearManageSelection={() => setSelectedManageDeptIds(new Set())}
      onCreateRootDepartment={() => {
        setDepartmentDialog({
          mode: 'create',
          parentId: null,
          name: '',
          description: '',
        });
      }}
      onCreateDepartment={(parentId) => {
        setDepartmentDialog({
          mode: 'create',
          parentId: parentId === archiveDepartmentId ? null : parentId,
          name: '',
          description: '',
        });
      }}
      onRenameDepartment={(departmentId) => {
        const department = flatDepts.find(item => item.id === departmentId);
        setDepartmentDialog({
          mode: 'rename',
          departmentId,
          name: department?.name || '',
        });
      }}
      onMoveDepartments={(departmentIds) => {
        setDepartmentDialog({
          mode: 'move',
          departmentIds,
          parentId: null,
        });
      }}
      onDeleteDepartments={(departmentIds) => {
        setDepartmentDialog({
          mode: 'delete',
          departmentIds,
        });
      }}
      onDeleteDepartmentRecursive={(departmentId) => {
        setDepartmentDialog({
          mode: 'deleteRecursive',
          departmentId,
        });
      }}
      onDropEmployees={canEdit ? handleDropEmployees : undefined}
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

      <div className="ep-emp-panel">
        <div className="ep-emp-header">
          <div className="ep-emp-header-top">
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
                <span className="ep-emp-count">{selectedCountLabel} чел.</span>
              </div>
              {isArchiveView && (
                <span className="ep-archive-chip">
                  <UserRoundX size={14} />
                  <span>Уволенные</span>
                </span>
              )}
            </div>
            <div className="ep-toolbar-actions">
              {selectedEmps.size > 0 && (
                <span className="ep-selection-chip">{selectedEmps.size} выбрано</span>
              )}
              {canEdit && !isArchiveView && (
                <button
                  className="ep-toolbar-btn primary"
                  onClick={() => openMoveModal([...selectedEmps])}
                  disabled={selectedEmps.size === 0}
                >
                  <MoveRight size={16} />
                  <span>Переместить</span>
                </button>
              )}
            </div>
          </div>

          <div className="ep-emp-toolbar">
            <div className="ep-toolbar-search">
              <Search size={14} />
              <input
                type="text"
                value={unifiedSearch}
                onChange={(event) => setUnifiedSearch(event.target.value)}
                placeholder="Найти сотрудника или отдел..."
              />
              {unifiedSearch && (
                <button className="ep-search-clear" onClick={() => setUnifiedSearch('')}>
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="ep-toolbar-filters">
              <div className="ep-chip-group">
                <button
                  className={`ep-filter-chip ${!isArchiveView ? 'active' : ''}`}
                  onClick={showActiveEmployees}
                >
                  Активные
                </button>
                {archiveDepartmentId && (
                  <button
                    className={`ep-filter-chip ${isArchiveView ? 'active danger' : ''}`}
                    onClick={showArchiveEmployees}
                  >
                    Уволенные
                  </button>
                )}
              </div>

              {selectedEmps.size > 0 && (
                <button className="ep-filter-chip ghost" onClick={() => setSelectedEmps(new Set())}>
                  Сбросить выбор
                </button>
              )}
            </div>
          </div>
        </div>

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
          allVisibleSelected={allVisibleSelected}
          onEmpClick={handleEmpClick}
          onToggleSelection={toggleEmpSelection}
          onToggleVisibleSelection={toggleVisibleEmployeesSelection}
        />

        {meta.totalPages > 1 && (
          <div className="ep-pagination">
            <button className="ep-pagination-btn" disabled={!canPrev} onClick={() => setPage(value => value - 1)}>
              <ChevronLeft size={16} />
            </button>
            <span className="ep-pagination-info">
              {meta.page} / {meta.totalPages}
            </span>
            <button className="ep-pagination-btn" disabled={!canNext} onClick={() => setPage(value => value + 1)}>
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>

      {editingEmployeeId !== null && editingEmployee && !isMobile && (
        <EmployeeSigurSidebar
          employeeId={editingEmployeeId}
          employee={editingEmployee}
          canEdit={canEdit}
          canPreviewAccessPointMap={canViewPage('/skud-settings')}
          onClose={resetEmployeeEditor}
          onOpenFullCard={openFullEmployeeCard}
          onMove={(employeeId) => openMoveModal([employeeId])}
          onFire={handleFireFromSidebar}
          onRehire={handleRehireFromSidebar}
        />
      )}

      {editingEmployeeId !== null && editingEmployee && isMobile && (
        <>
          <div className="ep-sigur-mobile-overlay" onClick={resetEmployeeEditor} />
          <div className="ep-sigur-mobile-sheet open">
            <EmployeeSigurSidebar
              employeeId={editingEmployeeId}
              employee={editingEmployee}
              canEdit={canEdit}
              canPreviewAccessPointMap={canViewPage('/skud-settings')}
              onClose={resetEmployeeEditor}
              onOpenFullCard={openFullEmployeeCard}
              onMove={(employeeId) => openMoveModal([employeeId])}
              onFire={handleFireFromSidebar}
              onRehire={handleRehireFromSidebar}
            />
          </div>
        </>
      )}

      {rehireEmployee && (
        <div className="ep-modal-overlay" onClick={rehireInFlight ? undefined : closeRehireModal}>
          <div className="ep-modal" onClick={event => event.stopPropagation()}>
            <div className="ep-modal-header">
              <span className="ep-modal-title">
                <ShieldCheck size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                Восстановить сотрудника
              </span>
              <button className="ep-modal-close" onClick={closeRehireModal} disabled={rehireInFlight}>
                <X size={14} />
              </button>
            </div>
            <div className="ep-modal-body">
              <label>Выберите отдел для {rehireEmployee.full_name}</label>
              <select
                value={rehireDeptId}
                onChange={event => setRehireDeptId(event.target.value)}
                className="ep-modal-select"
                disabled={rehireInFlight}
              >
                <option value="">— Выберите —</option>
                {moveTargetDepartments.map(department => (
                  <option key={department.id} value={department.id}>
                    {'  '.repeat(department.level)}{department.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" onClick={closeRehireModal} disabled={rehireInFlight}>
                Отмена
              </button>
              <button
                className="ep-modal-btn primary"
                onClick={handleConfirmRehire}
                disabled={!rehireDeptId || rehireInFlight}
              >
                {rehireInFlight ? 'Восстанавливаем...' : 'Восстановить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {moveEmployeeIds.length > 0 && (
        <div className="ep-modal-overlay" onClick={() => setMoveEmployeeIds([])}>
          <div className="ep-modal" onClick={event => event.stopPropagation()}>
            <div className="ep-modal-header">
              <span className="ep-modal-title">
                {moveEmployeeIds.length > 1 ? 'Переместить выбранных сотрудников' : 'Переместить в отдел'}
              </span>
              <button className="ep-modal-close" onClick={() => setMoveEmployeeIds([])}>
                <X size={14} />
              </button>
            </div>
            <div className="ep-modal-body">
              <label>Выберите отдел</label>
              <select
                value={moveDeptId}
                onChange={event => setMoveDeptId(event.target.value)}
                className="ep-modal-select"
              >
                <option value="">— Выберите —</option>
                {moveTargetDepartments.map(department => (
                  <option key={department.id} value={department.id}>
                    {'\u00A0\u00A0'.repeat(department.level)}{department.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" onClick={() => setMoveEmployeeIds([])}>
                Отмена
              </button>
              <button className="ep-modal-btn primary" onClick={handleConfirmMove} disabled={!moveDeptId}>
                Переместить
              </button>
            </div>
          </div>
        </div>
      )}

      {departmentDialog && (
        <div className="ep-modal-overlay" onClick={() => setDepartmentDialog(null)}>
          <div className="ep-modal" onClick={event => event.stopPropagation()}>
            <div className="ep-modal-header">
              <span className="ep-modal-title">
                {departmentDialog.mode === 'create' && 'Новый отдел'}
                {departmentDialog.mode === 'rename' && 'Переименовать отдел'}
                {departmentDialog.mode === 'move' && 'Переместить отделы'}
                {departmentDialog.mode === 'delete' && 'Удалить отделы'}
                {departmentDialog.mode === 'deleteRecursive' && 'Удалить ветку'}
              </span>
              <button className="ep-modal-close" onClick={() => setDepartmentDialog(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="ep-modal-body">
              {departmentDialog.mode === 'create' && (
                <div className="ep-modal-stack">
                  <label className="ep-form-field">
                    <span>Название</span>
                    <input
                      value={departmentDialog.name}
                      onChange={event => setDepartmentDialog(prev => prev?.mode === 'create' ? { ...prev, name: event.target.value } : prev)}
                    />
                  </label>
                  <label className="ep-form-field">
                    <span>Описание</span>
                    <textarea
                      rows={3}
                      value={departmentDialog.description}
                      onChange={event => setDepartmentDialog(prev => prev?.mode === 'create' ? { ...prev, description: event.target.value } : prev)}
                    />
                  </label>
                </div>
              )}
              {departmentDialog.mode === 'rename' && (
                <label className="ep-form-field">
                  <span>Новое название</span>
                  <input
                    value={departmentDialog.name}
                    onChange={event => setDepartmentDialog(prev => prev?.mode === 'rename' ? { ...prev, name: event.target.value } : prev)}
                  />
                </label>
              )}
              {departmentDialog.mode === 'move' && (
                <label className="ep-form-field">
                  <span>Новый родительский отдел</span>
                  <select
                    value={departmentDialog.parentId || ''}
                    onChange={event => setDepartmentDialog(prev => prev?.mode === 'move' ? { ...prev, parentId: event.target.value || null } : prev)}
                  >
                    <option value="">Корень</option>
                    {moveTargetDepartments
                      .filter(department => !departmentDialog.departmentIds.includes(department.id))
                      .map(department => (
                        <option key={department.id} value={department.id}>
                          {'\u00A0\u00A0'.repeat(department.level)}{department.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {departmentDialog.mode === 'delete' && (
                <div className="ep-danger-note">
                  <AlertTriangle size={18} />
                  <span>Удаление работает только для пустых отделов. Если внутри есть сотрудники или подпапки, используйте рекурсивное удаление или сначала перенесите содержимое.</span>
                </div>
              )}
              {departmentDialog.mode === 'deleteRecursive' && (
                <div className="ep-danger-note">
                  <AlertTriangle size={18} />
                  <span>Сотрудники из удаляемой ветки будут переведены в родительский отдел корня ветки. Операция необратима.</span>
                </div>
              )}
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" onClick={() => setDepartmentDialog(null)}>
                Отмена
              </button>
              <button className={`ep-modal-btn ${departmentDialog.mode === 'delete' || departmentDialog.mode === 'deleteRecursive' ? 'danger' : 'primary'}`} onClick={handleDepartmentAction} disabled={isDepartmentActionRunning}>
                {isDepartmentActionRunning ? 'Выполняем...' : 'Подтвердить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
