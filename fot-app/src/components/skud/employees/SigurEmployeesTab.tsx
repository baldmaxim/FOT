import { useCallback, useEffect, useMemo, useRef, useState, type FC, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  Database,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { sigurAdminService } from '../../../services/sigurAdminService';
import { useIsMobile } from '../../../hooks/useIsMobile';
import type { SigurDepartmentNode, SigurEmployeeSummary } from '../../../types';
import '../../../styles/EmployeesPage.css';
import './SigurEmployeesTab.css';
import { SigurLiveEmployeeSidebar } from './SigurLiveEmployeeSidebar';
import { ProgressBar } from '../../ui/ProgressBar';
import { DepartmentTreeNode } from './DepartmentTreeNode';
import {
  buildDepartmentNodeMap,
  collectDepartmentIds,
  collectExpandedSearchIds,
  DEPT_PANEL_MAX_WIDTH,
  DEPT_PANEL_MIN_WIDTH,
  DEPT_PANEL_WIDTH_KEY,
  EMPLOYEE_DRAG_TYPE,
  EMPLOYEES_PAGE_SIZE,
  findDepartmentById,
  flattenDepartments,
  getContextMenuPosition,
  getDepartmentPathIds,
  getEmployeeStatusPresentation,
  getMatchingDepartmentIds,
  getRootExpandedIds,
  readInitialDeptPanelWidth,
  type DeleteDepartmentsDialogState,
  type DepartmentContextMenuState,
  type DepartmentDialogState,
  type EmployeeDialogState,
  type EmployeeMoveDialogState,
  type EmployeeStatusFilter,
} from './sigurEmployeesTab.helpers';

interface ISigurEmployeesTabProps {
  canEdit: boolean;
  setError: (error: string) => void;
  headerActionSlot?: ReactNode;
  /** Внешний триггер открытия сотрудника по Sigur ID (через считыватель пропусков). key должен меняться, чтобы повторный пинг с тем же id срабатывал. */
  pendingOpen?: { sigurEmployeeId: number; fullName: string; key: number } | null;
}

const SIGUR_ADMIN_QUERY_KEY = ['sigur-admin'] as const;

export const SigurEmployeesTab: FC<ISigurEmployeesTabProps> = ({ canEdit, setError, headerActionSlot, pendingOpen }) => {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile(768);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const departmentNodeRefs = useRef(new Map<number, HTMLDivElement>());
  const deptPanelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [deptPanelWidth, setDeptPanelWidth] = useState<number>(readInitialDeptPanelWidth);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DEPT_PANEL_WIDTH_KEY, String(deptPanelWidth));
    } catch {
      // ignore quota errors
    }
  }, [deptPanelWidth]);

  const handleDeptResizeMove = useCallback((event: PointerEvent) => {
    if (!deptPanelResizeRef.current) return;
    const delta = event.clientX - deptPanelResizeRef.current.startX;
    const next = Math.min(
      DEPT_PANEL_MAX_WIDTH,
      Math.max(DEPT_PANEL_MIN_WIDTH, deptPanelResizeRef.current.startWidth + delta),
    );
    setDeptPanelWidth(next);
  }, []);

  const handleDeptResizeUp = useCallback(() => {
    deptPanelResizeRef.current = null;
    window.removeEventListener('pointermove', handleDeptResizeMove);
    window.removeEventListener('pointerup', handleDeptResizeUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [handleDeptResizeMove]);

  const handleDeptResizeDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    deptPanelResizeRef.current = { startX: event.clientX, startWidth: deptPanelWidth };
    window.addEventListener('pointermove', handleDeptResizeMove);
    window.addEventListener('pointerup', handleDeptResizeUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [deptPanelWidth, handleDeptResizeMove, handleDeptResizeUp]);

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handleDeptResizeMove);
      window.removeEventListener('pointerup', handleDeptResizeUp);
    };
  }, [handleDeptResizeMove, handleDeptResizeUp]);

  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [selectedManageDeptIds, setSelectedManageDeptIds] = useState<Set<number>>(new Set());
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<Set<number>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [departmentSearch, setDepartmentSearch] = useState('');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [debouncedEmployeeSearch, setDebouncedEmployeeSearch] = useState('');
  const [employeeStatusFilter, setEmployeeStatusFilter] = useState<EmployeeStatusFilter>('all');
  const [departmentDialog, setDepartmentDialog] = useState<DepartmentDialogState>(null);
  const [deleteDepartmentsDialog, setDeleteDepartmentsDialog] = useState<DeleteDepartmentsDialogState>(null);
  const [deletingDepartments, setDeletingDepartments] = useState(false);
  const [departmentContextMenu, setDepartmentContextMenu] = useState<DepartmentContextMenuState>(null);
  const [employeeDialog, setEmployeeDialog] = useState<EmployeeDialogState>(null);
  const [employeeMoveDialog, setEmployeeMoveDialog] = useState<EmployeeMoveDialogState>(null);
  const [newEmployeePositionName, setNewEmployeePositionName] = useState('');
  const [employeeNameSuggestionsQuery, setEmployeeNameSuggestionsQuery] = useState('');
  const [loadingSelectedSuggestion, setLoadingSelectedSuggestion] = useState(false);
  const [savingDepartment, setSavingDepartment] = useState(false);
  const [savingEmployee, setSavingEmployee] = useState(false);
  const [savingEmployeeMove, setSavingEmployeeMove] = useState(false);
  const [moveProgress, setMoveProgress] = useState<{ processed: number; total: number; failed: number } | null>(null);
  const [creatingEmployeePosition, setCreatingEmployeePosition] = useState(false);
  const [isDeptPanelOpen, setIsDeptPanelOpen] = useState(false);
  const [employeePage, setEmployeePage] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedEmployeeSearch(employeeSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [employeeSearch]);

  useEffect(() => {
    if (!employeeDialog || employeeDialog.mode !== 'create') {
      setEmployeeNameSuggestionsQuery('');
      return;
    }
    const trimmed = employeeDialog.name.trim();
    const timer = window.setTimeout(() => setEmployeeNameSuggestionsQuery(trimmed), 300);
    return () => window.clearTimeout(timer);
  }, [employeeDialog]);

  const departmentsQuery = useQuery({
    queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'departments-tree'],
    queryFn: () => sigurAdminService.getDepartmentsTree(),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
  });

  const positionsQuery = useQuery({
    queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'positions'],
    queryFn: () => sigurAdminService.getPositions(),
    enabled: canEdit && (employeeDialog !== null || selectedEmployeeId !== null),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
  });

  const employeeNameSuggestionsEnabled =
    employeeDialog?.mode === 'create' && employeeNameSuggestionsQuery.length >= 2;
  const employeeNameSuggestionsResult = useQuery({
    queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'employee-suggestions', employeeNameSuggestionsQuery],
    queryFn: () => sigurAdminService.getEmployees({
      search: employeeNameSuggestionsQuery,
      pageSize: 8,
    }),
    enabled: employeeNameSuggestionsEnabled,
    staleTime: 30 * 1000,
  });
  const employeeNameSuggestions = employeeNameSuggestionsResult.data?.items || [];

  const blockedFilter = employeeStatusFilter === 'all'
    ? undefined
    : employeeStatusFilter === 'blocked';

  const employeesQuery = useQuery({
    queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'employees', selectedDeptId, debouncedEmployeeSearch, employeeStatusFilter, employeePage],
    queryFn: () => sigurAdminService.getEmployees({
      departmentId: selectedDeptId,
      search: debouncedEmployeeSearch || undefined,
      blocked: blockedFilter,
      page: employeePage,
      pageSize: EMPLOYEES_PAGE_SIZE,
    }),
    staleTime: 60_000,
    placeholderData: previousData => previousData,
  });

  const departments = departmentsQuery.data || [];
  const departmentNodeMap = useMemo(() => buildDepartmentNodeMap(departments), [departments]);
  const departmentOptions = useMemo(() => flattenDepartments(departments), [departments]);
  const positions = positionsQuery.data || [];
  const employeesPayload = employeesQuery.data;
  const employees = employeesPayload?.items || [];
  const visibleEmployeeIds = useMemo(() => employees.map(employee => employee.id), [employees]);
  const employeeCardStatusesQuery = useQuery({
    queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'employee-card-statuses', visibleEmployeeIds.join(',')],
    queryFn: () => sigurAdminService.getEmployeeCardStatuses(visibleEmployeeIds),
    enabled: visibleEmployeeIds.length > 0,
    staleTime: 5 * 60 * 1000,
    placeholderData: previousData => previousData,
  });
  const employeeCardStatusMap = useMemo(() => new Map(
    (employeeCardStatusesQuery.data || []).map(status => [status.employeeId, status]),
  ), [employeeCardStatusesQuery.data]);
  const selectedDepartment = useMemo(
    () => findDepartmentById(departments, selectedDeptId),
    [departments, selectedDeptId],
  );
  const visibleDepartmentIds = useMemo(
    () => getMatchingDepartmentIds(departments, departmentSearch),
    [departments, departmentSearch],
  );
  const searchExpandedIds = useMemo(
    () => collectExpandedSearchIds(departments, visibleDepartmentIds),
    [departments, visibleDepartmentIds],
  );
  const effectiveExpandedIds = departmentSearch.trim() ? searchExpandedIds : expandedIds;
  const totalEmployeesCount = useMemo(
    () => departments.reduce((sum, department) => sum + department.employeeCount, 0),
    [departments],
  );
  const isGlobalSearchMode = selectedDeptId == null && debouncedEmployeeSearch.length > 0;
  const selectedDepartmentName = selectedDepartment?.name || (isGlobalSearchMode ? 'Глобальный поиск' : 'Все отделы Sigur');
  const rawSelectedDepartmentTotal = employeesPayload?.meta.total
    ?? (isGlobalSearchMode || selectedDeptId != null ? employees.length : totalEmployeesCount);
  const selectedDepartmentTotal = selectedDeptId == null && !isGlobalSearchMode && employeeStatusFilter === 'all'
    ? Math.max(rawSelectedDepartmentTotal, totalEmployeesCount)
    : rawSelectedDepartmentTotal;
  const totalEmployeePages = Math.max(1, Math.ceil(Math.max(1, selectedDepartmentTotal) / EMPLOYEES_PAGE_SIZE));
  const loadError = departmentsQuery.error || employeesQuery.error || null;
  const loadErrorMessage = loadError instanceof Error
    ? loadError.message
    : 'Не удалось загрузить live-данные Sigur';
  const positionsErrorMessage = positionsQuery.error instanceof Error
    ? positionsQuery.error.message
    : positionsQuery.error
      ? 'Не удалось загрузить справочник должностей Sigur'
      : '';
  const isInitialLoading = departmentsQuery.isPending || employeesQuery.isPending;

  const activeManageDepartmentIds = useMemo(() => (
    selectedManageDeptIds.size > 0
      ? [...selectedManageDeptIds]
      : (selectedDeptId != null ? [selectedDeptId] : [])
  ), [selectedManageDeptIds, selectedDeptId]);

  const activeManageDepartments = useMemo(
    () => activeManageDepartmentIds
      .map(id => departmentNodeMap.get(id))
      .filter((department): department is SigurDepartmentNode => !!department),
    [activeManageDepartmentIds, departmentNodeMap],
  );

  const canRenameManageSelection = activeManageDepartmentIds.length === 1;
  const canMoveManageSelection = activeManageDepartmentIds.length > 0;
  const canDeleteManageSelection = activeManageDepartments.length > 0;

  const allVisibleEmployeesSelected = useMemo(
    () => visibleEmployeeIds.length > 0 && visibleEmployeeIds.every(id => selectedEmployeeIds.has(id)),
    [selectedEmployeeIds, visibleEmployeeIds],
  );

  const moveTargetOptions = useMemo(() => {
    if (!departmentDialog || departmentDialog.mode !== 'move') return departmentOptions;
    const excludedIds = new Set<number>();
    departmentDialog.departmentIds.forEach(departmentId => {
      const ids = collectDepartmentIds(findDepartmentById(departments, departmentId));
      ids.forEach(id => excludedIds.add(id));
    });
    return departmentOptions.filter(option => !excludedIds.has(option.id));
  }, [departmentDialog, departmentOptions, departments]);

  useEffect(() => {
    if (departments.length === 0 || expandedIds.size > 0) return;
    setExpandedIds(getRootExpandedIds(departments));
  }, [departments, expandedIds.size]);

  useEffect(() => {
    if (selectedDeptId == null) return;
    const path = getDepartmentPathIds(departments, selectedDeptId);
    if (path.length === 0) return;
    setExpandedIds(prev => {
      const next = new Set(prev);
      path.slice(0, -1).forEach(id => next.add(id));
      return next;
    });
  }, [departments, selectedDeptId]);

  useEffect(() => {
    if (selectedDeptId != null && !departmentNodeMap.has(selectedDeptId)) {
      setSelectedDeptId(null);
      setSelectedEmployeeId(null);
    }
  }, [departmentNodeMap, selectedDeptId]);

  useEffect(() => {
    if (selectedManageDeptIds.size === 0) return;
    const validIds = new Set(departmentOptions.map(option => option.id));
    setSelectedManageDeptIds(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [departmentOptions, selectedManageDeptIds.size]);

  useEffect(() => {
    setEmployeePage(1);
  }, [selectedDeptId, debouncedEmployeeSearch, employeeStatusFilter]);

  useEffect(() => {
    setSelectedEmployeeIds(new Set());
  }, [selectedDeptId, debouncedEmployeeSearch, employeeStatusFilter]);

  useEffect(() => {
    if (employeePage <= totalEmployeePages) return;
    setEmployeePage(totalEmployeePages);
  }, [employeePage, totalEmployeePages]);

  useEffect(() => {
    if (!loadError) return;
    setError(loadErrorMessage);
  }, [loadError, loadErrorMessage, setError]);

  useEffect(() => {
    if (!positionsErrorMessage) return;
    setError(positionsErrorMessage);
  }, [positionsErrorMessage, setError]);

  useEffect(() => {
    if (!departmentContextMenu) return;

    const handleClose = (event?: Event) => {
      if (event && contextMenuRef.current?.contains(event.target as Node)) return;
      setDepartmentContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDepartmentContextMenu(null);
    };

    window.addEventListener('mousedown', handleClose);
    window.addEventListener('scroll', handleClose, true);
    window.addEventListener('resize', handleClose);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClose);
      window.removeEventListener('scroll', handleClose, true);
      window.removeEventListener('resize', handleClose);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [departmentContextMenu]);

  const refreshData = async () => {
    setError('');
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'departments-tree'] }),
      queryClient.invalidateQueries({ queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'employees'] }),
      queryClient.invalidateQueries({ queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'positions'] }),
    ]);
  };

  const toggleDepartment = (departmentId: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return next;
    });
  };

  const handleSelectDepartment = (departmentId: number | null) => {
    setSelectedDeptId(departmentId);
    setSelectedEmployeeId(null);
    if (isMobile) setIsDeptPanelOpen(false);
  };

  const handleToggleManageSelection = (departmentId: number) => {
    setSelectedManageDeptIds(prev => {
      const next = new Set(prev);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return next;
    });
  };

  const handleOpenDepartmentContextMenu = (event: ReactMouseEvent<HTMLDivElement>, departmentId: number) => {
    if (!canEdit) return;
    event.preventDefault();
    event.stopPropagation();

    const selection = selectedManageDeptIds.has(departmentId) && selectedManageDeptIds.size > 0
      ? [...selectedManageDeptIds]
      : [departmentId];

    setSelectedManageDeptIds(new Set(selection));
    setDepartmentContextMenu({
      x: event.clientX,
      y: event.clientY,
      selection,
    });
  };

  const openCreateDepartmentDialog = (parentId: number | null) => {
    setDepartmentDialog({ mode: 'create', parentId, name: '' });
    setDepartmentContextMenu(null);
  };

  const openRenameDepartmentDialog = (departmentId: number) => {
    const department = departmentNodeMap.get(departmentId);
    if (!department) return;
    setDepartmentDialog({
      mode: 'rename',
      departmentId,
      name: department.name,
    });
    setDepartmentContextMenu(null);
  };

  const openMoveDepartmentDialog = (departmentIds: number[]) => {
    if (departmentIds.length === 0) return;
    const fallbackParentId = departmentNodeMap.get(departmentIds[0])?.parentId || null;
    setDepartmentDialog({
      mode: 'move',
      departmentIds,
      parentId: fallbackParentId,
    });
    setDepartmentContextMenu(null);
  };

  const handleSaveDepartment = async () => {
    if (!departmentDialog) return;

    try {
      setSavingDepartment(true);
      setError('');

      if (departmentDialog.mode === 'create') {
        const created = await sigurAdminService.createDepartment({
          name: departmentDialog.name.trim(),
          parentId: departmentDialog.parentId,
        });
        setSelectedDeptId(created.id);
        setExpandedIds(prev => {
          const next = new Set(prev);
          if (created.parentId != null) next.add(created.parentId);
          return next;
        });
      }

      if (departmentDialog.mode === 'rename') {
        await sigurAdminService.updateDepartment(departmentDialog.departmentId, {
          name: departmentDialog.name.trim(),
        });
      }

      if (departmentDialog.mode === 'move') {
        await sigurAdminService.batchMoveDepartments(departmentDialog.departmentIds, departmentDialog.parentId);
      }

      setDepartmentDialog(null);
      await refreshData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось сохранить изменения отдела Sigur');
    } finally {
      setSavingDepartment(false);
    }
  };

  const openDeleteDepartmentsDialog = (departmentIds: number[]) => {
    if (departmentIds.length === 0) return;
    const names: string[] = [];
    let totalChildDepts = 0;
    let directEmployees = 0;
    let totalEmployees = 0;
    let hasChildren = false;

    const walkSubtree = (node: SigurDepartmentNode) => {
      for (const child of node.children || []) {
        totalChildDepts += 1;
        totalEmployees += child.employeeCount || 0;
        walkSubtree(child);
      }
    };

    for (const id of departmentIds) {
      const node = departmentNodeMap.get(id);
      if (!node) continue;
      names.push(node.name);
      directEmployees += node.employeeCount || 0;
      totalEmployees += node.employeeCount || 0;
      if (node.hasChildren || (node.children && node.children.length > 0)) {
        hasChildren = true;
      }
      walkSubtree(node);
    }

    setDeleteDepartmentsDialog({
      departmentIds,
      names,
      totalChildDepts,
      directEmployees,
      totalEmployees,
      hasChildren,
    });
    setDepartmentContextMenu(null);
  };

  const confirmDeleteDepartments = async () => {
    const dialog = deleteDepartmentsDialog;
    if (!dialog || dialog.departmentIds.length === 0) return;

    setDeletingDepartments(true);
    try {
      setError('');
      if (dialog.hasChildren) {
        for (const id of dialog.departmentIds) {
          await sigurAdminService.deleteDepartmentRecursive(id);
        }
      } else {
        for (const id of dialog.departmentIds) {
          await sigurAdminService.deleteDepartment(id);
        }
      }
      if (selectedDeptId != null && dialog.departmentIds.includes(selectedDeptId)) {
        setSelectedDeptId(null);
        setSelectedEmployeeId(null);
      }
      setSelectedManageDeptIds(new Set());
      setDepartmentContextMenu(null);
      setDeleteDepartmentsDialog(null);
      await refreshData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось удалить отделы Sigur');
    } finally {
      setDeletingDepartments(false);
    }
  };

  const openCreateEmployeeDialog = () => {
    setEmployeeDialog({
      mode: 'create',
      sigurEmployeeId: null,
      name: '',
      departmentId: selectedDeptId != null ? String(selectedDeptId) : '',
      positionId: '',
      tabId: '',
      description: '',
      blocked: false,
    });
    setNewEmployeePositionName('');
    setEmployeeNameSuggestionsQuery('');
  };

  const handleCreateEmployeePosition = async () => {
    const name = newEmployeePositionName.trim();
    if (!name) {
      setError('Введите название новой должности');
      return;
    }

    try {
      setCreatingEmployeePosition(true);
      setError('');
      const created = await sigurAdminService.createPosition(name);
      setEmployeeDialog(prev => prev ? { ...prev, positionId: String(created.id) } : prev);
      setNewEmployeePositionName('');
      await queryClient.invalidateQueries({ queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'positions'] });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось создать должность Sigur');
    } finally {
      setCreatingEmployeePosition(false);
    }
  };

  const handleSelectEmployeeSuggestion = async (suggestion: SigurEmployeeSummary) => {
    try {
      setLoadingSelectedSuggestion(true);
      setError('');
      const profile = await sigurAdminService.getEmployeeProfile(suggestion.id);
      setEmployeeDialog({
        mode: 'edit',
        sigurEmployeeId: profile.sigurEmployeeId,
        name: profile.profile.fullName ?? suggestion.name,
        departmentId: profile.profile.departmentId != null ? String(profile.profile.departmentId) : '',
        positionId: profile.profile.positionId != null ? String(profile.profile.positionId) : '',
        tabId: profile.profile.tabNumber ?? '',
        description: profile.profile.description ?? '',
        blocked: profile.profile.blocked === true,
      });
      setEmployeeNameSuggestionsQuery('');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось загрузить профиль сотрудника Sigur');
    } finally {
      setLoadingSelectedSuggestion(false);
    }
  };

  const handleSaveEmployee = async () => {
    if (!employeeDialog) return;
    if (!employeeDialog.name.trim() || !employeeDialog.departmentId) {
      setError('Для сотрудника нужны ФИО и отдел');
      return;
    }

    try {
      setSavingEmployee(true);
      setError('');
      const profile = employeeDialog.mode === 'edit' && employeeDialog.sigurEmployeeId != null
        ? await sigurAdminService.updateEmployee(employeeDialog.sigurEmployeeId, {
            name: employeeDialog.name.trim(),
            departmentId: Number(employeeDialog.departmentId),
            positionId: employeeDialog.positionId ? Number(employeeDialog.positionId) : null,
            tabId: employeeDialog.tabId.trim() || null,
            description: employeeDialog.description.trim() || null,
            blocked: employeeDialog.blocked,
          })
        : await sigurAdminService.createEmployee({
            name: employeeDialog.name.trim(),
            departmentId: Number(employeeDialog.departmentId),
            positionId: employeeDialog.positionId ? Number(employeeDialog.positionId) : null,
            tabId: employeeDialog.tabId.trim() || null,
            description: employeeDialog.description.trim() || null,
            blocked: employeeDialog.blocked,
          });
      setEmployeeDialog(null);
      setSelectedDeptId(profile.profile.departmentId ?? Number(employeeDialog.departmentId));
      setSelectedEmployeeId(profile.sigurEmployeeId);
      setEmployeeSearch('');
      setExpandedIds(prev => {
        const next = new Set(prev);
        const departmentId = profile.profile.departmentId ?? Number(employeeDialog.departmentId);
        getDepartmentPathIds(departments, departmentId).slice(0, -1).forEach(id => next.add(id));
        return next;
      });
      await refreshData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось сохранить сотрудника Sigur');
    } finally {
      setSavingEmployee(false);
    }
  };

  const handleToggleEmployeeSelection = (employeeId: number) => {
    setSelectedEmployeeIds(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  };

  const handleToggleVisibleEmployeeSelection = () => {
    setSelectedEmployeeIds(prev => {
      const next = new Set(prev);
      if (allVisibleEmployeesSelected) {
        visibleEmployeeIds.forEach(id => next.delete(id));
      } else {
        visibleEmployeeIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const openEmployeeMoveDialog = (employeeIds: number[]) => {
    if (employeeIds.length === 0) return;
    setEmployeeMoveDialog({
      employeeIds,
      departmentId: selectedDeptId != null ? String(selectedDeptId) : '',
    });
  };

  const handleSaveEmployeeMove = async () => {
    if (!employeeMoveDialog || !employeeMoveDialog.departmentId) {
      setError('Выберите отдел для перемещения сотрудников');
      return;
    }

    try {
      setSavingEmployeeMove(true);
      setMoveProgress({ processed: 0, total: employeeMoveDialog.employeeIds.length, failed: 0 });
      setError('');
      await sigurAdminService.batchMoveEmployeesStream(
        employeeMoveDialog.employeeIds,
        Number(employeeMoveDialog.departmentId),
        event => {
          if (event.type === 'start') {
            setMoveProgress({ processed: 0, total: event.total, failed: 0 });
            return;
          }
          if (event.type === 'progress') {
            setMoveProgress({ processed: event.processed, total: event.total, failed: event.failed });
          }
        },
      );
      setEmployeeMoveDialog(null);
      setSelectedEmployeeIds(new Set());
      await refreshData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось переместить сотрудников Sigur');
    } finally {
      setSavingEmployeeMove(false);
      setMoveProgress(null);
    }
  };

  const handleDropEmployees = async (departmentId: number, employeeIds: number[]) => {
    if (!canEdit || employeeIds.length === 0) return;

    try {
      setError('');
      await sigurAdminService.batchMoveEmployees(employeeIds, departmentId);
      setSelectedEmployeeIds(prev => {
        const next = new Set(prev);
        employeeIds.forEach(id => next.delete(id));
        return next;
      });
      await refreshData();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось переместить сотрудников в отдел');
    }
  };

  const handleOpenEmployee = (employee: SigurEmployeeSummary) => {
    if (isGlobalSearchMode && employee.departmentId != null) {
      const path = getDepartmentPathIds(departments, employee.departmentId);
      setExpandedIds(prev => {
        const next = new Set(prev);
        path.slice(0, -1).forEach(id => next.add(id));
        return next;
      });
      setDepartmentSearch('');
      setSelectedDeptId(employee.departmentId);
      setEmployeeSearch('');
    }
    setSelectedEmployeeId(employee.id);
  };

  useEffect(() => {
    if (selectedDeptId == null) return;
    const node = departmentNodeRefs.current.get(selectedDeptId);
    if (!node) return;

    window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [selectedDeptId, effectiveExpandedIds]);

  // Внешний триггер из считывателя пропусков: открыть сотрудника + sidebar.
  useEffect(() => {
    if (!pendingOpen) return;
    const { sigurEmployeeId, fullName } = pendingOpen;
    setSelectedDeptId(null);            // снимаем фильтр по отделу — глобальный поиск
    setDepartmentSearch('');
    setEmployeeStatusFilter('all');
    setEmployeeSearch(fullName);        // подгрузит сотрудника по ФИО
    setSelectedEmployeeId(sigurEmployeeId);
    setSelectedEmployeeIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen?.key]);

  const registerDepartmentNodeRef = (departmentId: number, element: HTMLDivElement | null) => {
    if (element) {
      departmentNodeRefs.current.set(departmentId, element);
      return;
    }
    departmentNodeRefs.current.delete(departmentId);
  };

  const renderDepartmentTree = () => {
    if (departmentsQuery.isPending && departments.length === 0) {
      return <div className="ep-loading">Загрузка отделов Sigur...</div>;
    }

    if (departmentsQuery.error && departments.length === 0) {
      return (
        <div className="ep-empty">
          <div className="ep-empty-icon"><Database size={24} /></div>
          <h3>Не удалось загрузить отделы</h3>
          <p>{departmentsQuery.error instanceof Error ? departmentsQuery.error.message : 'Попробуйте обновить данные.'}</p>
        </div>
      );
    }

    if (visibleDepartmentIds && visibleDepartmentIds.size === 0) {
      return (
        <div className="ep-empty">
          <div className="ep-empty-icon"><Folder size={24} /></div>
          <h3>Отделы не найдены</h3>
          <p>Измените строку поиска по дереву.</p>
        </div>
      );
    }

    return (
      <>
        <div
          className={`ep-dept-header ep-dept-all ${selectedDeptId == null ? 'active' : ''}`}
          onClick={() => handleSelectDepartment(null)}
        >
          <Users size={16} className="ep-dept-icon" />
          <span className="ep-dept-name">Все отделы</span>
          <span className="ep-dept-count">
            {(selectedDeptId == null && employeesPayload?.meta.total != null)
              ? (!isGlobalSearchMode && employeeStatusFilter === 'all'
                ? Math.max(employeesPayload.meta.total, totalEmployeesCount)
                : employeesPayload.meta.total)
              : totalEmployeesCount}
          </span>
        </div>
        {departments.map(node => (
          <DepartmentTreeNode
            key={node.id}
            node={node}
            level={0}
            selectedDeptId={selectedDeptId}
            expandedIds={effectiveExpandedIds}
            visibleIds={visibleDepartmentIds}
            manageSelectedIds={selectedManageDeptIds}
            canManage={canEdit}
            onSelect={handleSelectDepartment}
            onToggle={toggleDepartment}
            onToggleManageSelection={handleToggleManageSelection}
            onOpenContextMenu={handleOpenDepartmentContextMenu}
            onDropEmployees={handleDropEmployees}
            registerNodeRef={registerDepartmentNodeRef}
          />
        ))}
      </>
    );
  };

  const renderEmployeesTable = () => {
    if (isInitialLoading && employees.length === 0) {
      return <div className="ep-emp-list"><div className="ep-loading">Загрузка сотрудников Sigur...</div></div>;
    }

    if (loadError && employees.length === 0) {
      return (
        <div className="ep-emp-list">
          <div className="ep-empty">
            <div className="ep-empty-icon"><Database size={28} /></div>
            <h3>Не удалось загрузить сотрудников</h3>
            <p>{loadErrorMessage}</p>
            <button className="ep-toolbar-btn secondary" onClick={() => void refreshData()}>
              <RefreshCw size={16} />
              <span>Повторить</span>
            </button>
          </div>
        </div>
      );
    }

    if (employees.length === 0) {
      return (
        <div className="ep-emp-list">
          <div className="ep-empty">
            <div className="ep-empty-icon"><Database size={28} /></div>
            <h3>Сотрудники не найдены</h3>
            <p>Проверьте поиск, выбранный отдел или статусный фильтр.</p>
          </div>
        </div>
      );
    }

    return (
      <div className="ep-emp-list">
        <div className="ep-table-shell">
          <table className="ep-emp-table sigur-live-employee-table">
            <thead>
              <tr>
                {canEdit && (
                  <th className="ep-col-check">
                    <label className={`ep-table-check ${allVisibleEmployeesSelected ? 'checked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={allVisibleEmployeesSelected}
                        onChange={handleToggleVisibleEmployeeSelection}
                        aria-label="Выбрать сотрудников на странице"
                      />
                      <span />
                    </label>
                  </th>
                )}
                <th>ФИО</th>
                {!isMobile && <th>Отдел</th>}
                {!isMobile && <th>Должность</th>}
                {!isMobile && <th>Таб. №</th>}
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {employees.map(employeeItem => {
                const rowSelected = selectedEmployeeIds.has(employeeItem.id) || selectedEmployeeId === employeeItem.id;
                const statusPresentation = getEmployeeStatusPresentation(
                  employeeItem,
                  employeeCardStatusMap.get(employeeItem.id),
                  employeeCardStatusesQuery.isFetching,
                );
                return (
                  <tr
                    key={employeeItem.id}
                    className={rowSelected ? 'selected' : ''}
                    draggable={canEdit}
                    onDragStart={event => {
                      const employeeIds = selectedEmployeeIds.has(employeeItem.id) && selectedEmployeeIds.size > 0
                        ? [...selectedEmployeeIds]
                        : [employeeItem.id];
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData(EMPLOYEE_DRAG_TYPE, JSON.stringify({ employeeIds }));
                    }}
                    onClick={() => handleOpenEmployee(employeeItem)}
                  >
                    {canEdit && (
                      <td className="ep-col-check" onClick={event => event.stopPropagation()}>
                        <label className={`ep-table-check ${selectedEmployeeIds.has(employeeItem.id) ? 'checked' : ''}`}>
                          <input
                            type="checkbox"
                            checked={selectedEmployeeIds.has(employeeItem.id)}
                            onChange={() => handleToggleEmployeeSelection(employeeItem.id)}
                            aria-label={`Выбрать ${employeeItem.name}`}
                          />
                          <span />
                        </label>
                      </td>
                    )}
                    <td className="ep-cell-name">
                      <div className="ep-table-name">
                        <span>{employeeItem.name}</span>
                      </div>
                    </td>
                    {!isMobile && <td className="ep-cell-muted">{employeeItem.departmentName || '—'}</td>}
                    {!isMobile && <td className="ep-cell-muted">{employeeItem.positionName || '—'}</td>}
                    {!isMobile && <td className="ep-cell-muted">{employeeItem.tabId || '—'}</td>}
                    <td>
                      <span className={`sigur-live-status ${statusPresentation.tone}`}>
                        {statusPresentation.text}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {selectedDepartmentTotal > EMPLOYEES_PAGE_SIZE && (
          <div className="sigur-live-pagination">
            <div className="sigur-live-pagination-status">
              {`Показаны ${(employeePage - 1) * EMPLOYEES_PAGE_SIZE + 1}-${Math.min(employeePage * EMPLOYEES_PAGE_SIZE, selectedDepartmentTotal)} из ${selectedDepartmentTotal}`}
            </div>
            <div className="sigur-live-pagination-actions">
              <button
                className="ep-toolbar-btn secondary"
                onClick={() => setEmployeePage(page => Math.max(1, page - 1))}
                disabled={employeePage <= 1}
              >
                <ChevronLeft size={16} />
                <span>Назад</span>
              </button>
              <span className="sigur-live-pagination-page">
                {employeePage} / {totalEmployeePages}
              </span>
              <button
                className="ep-toolbar-btn secondary"
                onClick={() => setEmployeePage(page => Math.min(totalEmployeePages, page + 1))}
                disabled={employeePage >= totalEmployeePages}
              >
                <span>Вперёд</span>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderEmployeePanel = () => (
    <div className="ep-emp-panel">
      <div className="ep-emp-header">
        <div className="ep-emp-header-top">
          <div className="ep-emp-head-main">
            {isMobile && (
              <button className="ep-mobile-filter-btn" onClick={() => setIsDeptPanelOpen(true)}>
                <Folder size={16} />
                <span className="ep-mobile-filter-label">{selectedDepartmentName}</span>
              </button>
            )}
            <div className="ep-emp-title">
              <h2>{selectedDepartmentName}</h2>
              <span className="ep-emp-count">
                {`${selectedDepartmentTotal} чел.`}
              </span>
            </div>
          </div>
          <div className="ep-toolbar-actions">
            {canEdit && selectedEmployeeIds.size > 0 && (
              <span className="ep-selection-chip">{`Выбрано: ${selectedEmployeeIds.size}`}</span>
            )}
            {canEdit && selectedEmployeeIds.size > 0 && (
              <button className="ep-toolbar-btn secondary" onClick={() => openEmployeeMoveDialog([...selectedEmployeeIds])}>
                <ArrowRightLeft size={16} />
                <span>Переместить</span>
              </button>
            )}
            {canEdit && (
              <button className="ep-toolbar-btn primary" onClick={openCreateEmployeeDialog}>
                <UserPlus size={16} />
                <span>Новый сотрудник</span>
              </button>
            )}
            {headerActionSlot}
          </div>
        </div>

        <div className="ep-emp-toolbar">
          <div className="ep-toolbar-search">
            <Search size={14} />
            <input
              type="text"
              value={employeeSearch}
              onChange={event => setEmployeeSearch(event.target.value)}
              placeholder={selectedDeptId == null ? 'Поиск сотрудников по всем отделам...' : 'Поиск внутри отдела...'}
            />
            {employeeSearch && (
              <button className="ep-search-clear" onClick={() => setEmployeeSearch('')} aria-label="Очистить поиск">
                <X size={14} />
              </button>
            )}
          </div>
          <div className="ep-toolbar-filters">
            <div className="ep-chip-group">
              <button
                className={`ep-filter-chip ${employeeStatusFilter === 'all' ? 'active' : ''}`}
                onClick={() => setEmployeeStatusFilter('all')}
              >
                Все
              </button>
              <button
                className={`ep-filter-chip ${employeeStatusFilter === 'active' ? 'active' : ''}`}
                onClick={() => setEmployeeStatusFilter('active')}
              >
                Активные
              </button>
              <button
                className={`ep-filter-chip danger ${employeeStatusFilter === 'blocked' ? 'active danger' : ''}`}
                onClick={() => setEmployeeStatusFilter('blocked')}
              >
                Заблокированные
              </button>
            </div>
            {canEdit && selectedEmployeeIds.size > 0 && (
              <button className="ep-toolbar-btn secondary" onClick={() => setSelectedEmployeeIds(new Set())}>
                <X size={16} />
                <span>Снять выбор</span>
              </button>
            )}
            <button className="ep-toolbar-btn secondary" onClick={() => void refreshData()}>
              <RefreshCw size={16} />
              <span>Обновить</span>
            </button>
          </div>
        </div>
      </div>

      {renderEmployeesTable()}
    </div>
  );

  const contextMenuSelection = departmentContextMenu?.selection || [];
  const contextCanRename = contextMenuSelection.length === 1;
  const contextCanDelete = contextMenuSelection.length > 0;

  return (
    <div className="sigur-live-page">
      <div className="employees-page sigur-live-employees-layout">
        {!isMobile && (
          <div className="ep-dept-panel" style={{ width: deptPanelWidth }}>
            <div
              className="ep-dept-panel-resizer"
              onPointerDown={handleDeptResizeDown}
              role="separator"
              aria-orientation="vertical"
              aria-label="Изменить ширину панели отделов"
            />
            <div className="ep-dept-panel-header">
              <div className="ep-panel-title">
                <Folder size={16} />
                <span>Отделы Sigur</span>
                {selectedManageDeptIds.size > 0 && <span className="ep-dept-selection-pill">{selectedManageDeptIds.size}</span>}
              </div>
              <div className="ep-panel-actions">
                <button className="ep-panel-btn" onClick={() => void refreshData()} title="Обновить">
                  <RefreshCw size={15} />
                </button>
              </div>
            </div>

            {canEdit && (
              <div className="ep-dept-manage-toolbar ep-dept-manage-toolbar-compact">
                <div className="ep-dept-manage-title">
                  <span>Управление деревом</span>
                </div>
                <div className="ep-dept-manage-actions">
                  <button
                    type="button"
                    className="ep-mini-btn icon-only"
                    onClick={() => openCreateDepartmentDialog(null)}
                    title="Создать корневой отдел"
                    aria-label="Создать корневой отдел"
                  >
                    <Plus size={16} />
                  </button>
                  <button
                    type="button"
                    className="ep-mini-btn icon-only"
                    onClick={() => openCreateDepartmentDialog(selectedDeptId)}
                    disabled={selectedDeptId == null}
                    title="Создать подпапку в выбранном отделе"
                    aria-label="Создать подпапку"
                  >
                    <FolderPlus size={16} />
                  </button>
                  <button
                    type="button"
                    className="ep-mini-btn icon-only"
                    onClick={() => openRenameDepartmentDialog(activeManageDepartmentIds[0])}
                    disabled={!canRenameManageSelection}
                    title="Переименовать выбранный отдел"
                    aria-label="Переименовать"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    className="ep-mini-btn icon-only"
                    onClick={() => openMoveDepartmentDialog(activeManageDepartmentIds)}
                    disabled={!canMoveManageSelection}
                    title="Переместить выбранные отделы"
                    aria-label="Переместить"
                  >
                    <ArrowRightLeft size={16} />
                  </button>
                  <button
                    type="button"
                    className="ep-mini-btn icon-only danger"
                    onClick={() => openDeleteDepartmentsDialog(activeManageDepartmentIds)}
                    disabled={!canDeleteManageSelection}
                    title="Удалить выбранные отделы"
                    aria-label="Удалить"
                  >
                    <Trash2 size={16} />
                  </button>
                  {selectedManageDeptIds.size > 0 && (
                    <button
                      type="button"
                      className="ep-mini-btn icon-only"
                      onClick={() => setSelectedManageDeptIds(new Set())}
                      title="Снять выделение"
                      aria-label="Снять выделение"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="ep-dept-search-wrap">
              <Search size={14} />
              <input
                type="text"
                placeholder="Поиск отдела..."
                value={departmentSearch}
                onChange={event => setDepartmentSearch(event.target.value)}
              />
              {departmentSearch && (
                <button className="ep-search-clear" onClick={() => setDepartmentSearch('')} aria-label="Очистить поиск">
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="ep-dept-tree">
              {renderDepartmentTree()}
            </div>
          </div>
        )}

        {renderEmployeePanel()}

        {!isMobile && selectedEmployeeId != null && (
          <SigurLiveEmployeeSidebar
            sigurEmployeeId={selectedEmployeeId}
            employee={employees.find(item => item.id === selectedEmployeeId) || null}
            canEdit={canEdit}
            departments={departments}
            positions={positions}
            positionsLoading={positionsQuery.isLoading}
            onClose={() => setSelectedEmployeeId(null)}
            onDirectoryChanged={refreshData}
            onPositionsChanged={refreshData}
            onDeleted={(sigurEmployeeId) => {
              if (selectedEmployeeId === sigurEmployeeId) setSelectedEmployeeId(null);
            }}
          />
        )}
      </div>

      {isMobile && (
        <>
          <div
            className={`ep-dept-mobile-overlay ${isDeptPanelOpen ? 'open' : ''}`}
            onClick={() => setIsDeptPanelOpen(false)}
          />
          <div className={`ep-dept-mobile-sheet ${isDeptPanelOpen ? 'open' : ''}`}>
            <div className="ep-dept-panel">
              <div className="ep-dept-panel-header">
                <div className="ep-panel-title">
                  <Folder size={16} />
                  <span>Отделы Sigur</span>
                  {selectedManageDeptIds.size > 0 && <span className="ep-dept-selection-pill">{selectedManageDeptIds.size}</span>}
                </div>
                <div className="ep-panel-actions">
                  <button className="ep-panel-btn" onClick={() => void refreshData()} title="Обновить">
                    <RefreshCw size={15} />
                  </button>
                </div>
              </div>

              {canEdit && (
                <div className="ep-dept-manage-toolbar ep-dept-manage-toolbar-compact">
                  <div className="ep-dept-manage-title">
                    <span>Управление деревом</span>
                  </div>
                  <div className="ep-dept-manage-actions">
                    <button
                      type="button"
                      className="ep-mini-btn icon-only"
                      onClick={() => openCreateDepartmentDialog(null)}
                      title="Создать корневой отдел"
                      aria-label="Создать корневой отдел"
                    >
                      <Plus size={16} />
                    </button>
                    <button
                      type="button"
                      className="ep-mini-btn icon-only"
                      onClick={() => openCreateDepartmentDialog(selectedDeptId)}
                      disabled={selectedDeptId == null}
                      title="Создать подпапку в выбранном отделе"
                      aria-label="Создать подпапку"
                    >
                      <FolderPlus size={16} />
                    </button>
                    <button
                      type="button"
                      className="ep-mini-btn icon-only"
                      onClick={() => openRenameDepartmentDialog(activeManageDepartmentIds[0])}
                      disabled={!canRenameManageSelection}
                      title="Переименовать выбранный отдел"
                      aria-label="Переименовать"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      className="ep-mini-btn icon-only"
                      onClick={() => openMoveDepartmentDialog(activeManageDepartmentIds)}
                      disabled={!canMoveManageSelection}
                      title="Переместить выбранные отделы"
                      aria-label="Переместить"
                    >
                      <ArrowRightLeft size={16} />
                    </button>
                    <button
                      type="button"
                      className="ep-mini-btn icon-only danger"
                      onClick={() => openDeleteDepartmentsDialog(activeManageDepartmentIds)}
                      disabled={!canDeleteManageSelection}
                      title="Удалить выбранные отделы"
                      aria-label="Удалить"
                    >
                      <Trash2 size={16} />
                    </button>
                    {selectedManageDeptIds.size > 0 && (
                      <button
                        type="button"
                        className="ep-mini-btn icon-only"
                        onClick={() => setSelectedManageDeptIds(new Set())}
                        title="Снять выделение"
                        aria-label="Снять выделение"
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="ep-dept-search-wrap">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="Поиск отдела..."
                  value={departmentSearch}
                  onChange={event => setDepartmentSearch(event.target.value)}
                />
              </div>
              <div className="ep-dept-tree">
                {renderDepartmentTree()}
              </div>
            </div>
          </div>
        </>
      )}

      {selectedEmployeeId != null && isMobile && (
        <>
          <div className="ep-sigur-mobile-overlay" onClick={() => setSelectedEmployeeId(null)} />
          <div className="ep-sigur-mobile-sheet open">
            <SigurLiveEmployeeSidebar
              sigurEmployeeId={selectedEmployeeId}
              employee={employees.find(item => item.id === selectedEmployeeId) || null}
              canEdit={canEdit}
              departments={departments}
              positions={positions}
              positionsLoading={positionsQuery.isLoading}
              onClose={() => setSelectedEmployeeId(null)}
              onDirectoryChanged={refreshData}
              onPositionsChanged={refreshData}
              onDeleted={(sigurEmployeeId) => {
                if (selectedEmployeeId === sigurEmployeeId) setSelectedEmployeeId(null);
              }}
            />
          </div>
        </>
      )}

      {departmentContextMenu && canEdit && (
        <div
          ref={contextMenuRef}
          className="ep-tree-context-menu"
          style={getContextMenuPosition(departmentContextMenu)}
        >
          <button
            className="ep-tree-context-item"
            onClick={() => openCreateDepartmentDialog(contextMenuSelection[0] || null)}
            disabled={contextMenuSelection.length !== 1}
          >
            Создать подпапку
          </button>
          <button
            className="ep-tree-context-item"
            onClick={() => openRenameDepartmentDialog(contextMenuSelection[0])}
            disabled={!contextCanRename}
          >
            Переименовать
          </button>
          <button
            className="ep-tree-context-item"
            onClick={() => openMoveDepartmentDialog(contextMenuSelection)}
            disabled={contextMenuSelection.length === 0}
          >
            Переместить
          </button>
          <button
            className="ep-tree-context-item danger"
            onClick={() => openDeleteDepartmentsDialog(contextMenuSelection)}
            disabled={!contextCanDelete}
          >
            Удалить
          </button>
        </div>
      )}

      {departmentDialog && (
        <div className="ep-modal-overlay" onClick={() => setDepartmentDialog(null)}>
          <div className="ep-modal" onClick={event => event.stopPropagation()}>
            <div className="ep-modal-header">
              <div className="ep-modal-heading">
                <div className="ep-modal-title">
                  {departmentDialog.mode === 'create' && 'Новый отдел Sigur'}
                  {departmentDialog.mode === 'rename' && 'Переименовать отдел Sigur'}
                  {departmentDialog.mode === 'move' && `Переместить ${departmentDialog.departmentIds.length} ${departmentDialog.departmentIds.length === 1 ? 'отдел' : 'отдела'}`}
                </div>
              </div>
            </div>
            <div className="ep-modal-body">
              {departmentDialog.mode === 'create' || departmentDialog.mode === 'rename' ? (
                <label>
                  Название
                  <input
                    className="ep-modal-input"
                    value={departmentDialog.name}
                    onChange={event => setDepartmentDialog(prev => (
                      prev && (prev.mode === 'create' || prev.mode === 'rename')
                        ? { ...prev, name: event.target.value }
                        : prev
                    ))}
                  />
                </label>
              ) : (
                <label>
                  Новый родитель
                  <select
                    className="ep-modal-select"
                    value={departmentDialog.parentId == null ? '' : String(departmentDialog.parentId)}
                    onChange={event => setDepartmentDialog(prev => (
                      prev && prev.mode === 'move'
                        ? { ...prev, parentId: event.target.value ? Number(event.target.value) : null }
                        : prev
                    ))}
                  >
                    <option value="">В корень</option>
                    {moveTargetOptions.map(option => (
                      <option key={option.id} value={option.id}>
                        {'\u00A0\u00A0'.repeat(option.level)}{option.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" onClick={() => setDepartmentDialog(null)}>
                Отмена
              </button>
              <button className="ep-modal-btn primary" onClick={() => void handleSaveDepartment()} disabled={savingDepartment}>
                {savingDepartment ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteDepartmentsDialog && (
        <div className="ep-modal-overlay" onClick={() => !deletingDepartments && setDeleteDepartmentsDialog(null)}>
          <div className="ep-modal" onClick={event => event.stopPropagation()}>
            <div className="ep-modal-header">
              <div className="ep-modal-heading">
                <div className="ep-modal-title">
                  {deleteDepartmentsDialog.departmentIds.length === 1
                    ? `Удалить отдел «${deleteDepartmentsDialog.names[0] ?? ''}»?`
                    : `Удалить ${deleteDepartmentsDialog.departmentIds.length} отдел(ов)?`}
                </div>
              </div>
            </div>
            <div className="ep-modal-body">
              {deleteDepartmentsDialog.names.length > 1 && (
                <ul className="ep-delete-list">
                  {deleteDepartmentsDialog.names.map((name, index) => (
                    <li key={`${name}-${index}`}>{name}</li>
                  ))}
                </ul>
              )}
              <div className="ep-danger-note">
                <Trash2 size={18} />
                <div>
                  {deleteDepartmentsDialog.hasChildren ? (
                    <>
                      <div><b>Будет удалена вся ветка</b> — вместе со вложенными отделами{deleteDepartmentsDialog.totalChildDepts > 0 ? ` (${deleteDepartmentsDialog.totalChildDepts} шт.)` : ''}.</div>
                      {deleteDepartmentsDialog.totalEmployees > 0 && (
                        <div style={{ marginTop: 6 }}>
                          Сотрудники ({deleteDepartmentsDialog.totalEmployees}) будут перенесены в родительский отдел.
                        </div>
                      )}
                    </>
                  ) : deleteDepartmentsDialog.directEmployees > 0 ? (
                    <div>
                      В отделе {deleteDepartmentsDialog.directEmployees} сотрудник(ов). Они будут перенесены в родительский отдел.
                    </div>
                  ) : (
                    <div>Отдел пуст — будет удалён без последствий.</div>
                  )}
                </div>
              </div>
            </div>
            <div className="ep-modal-footer">
              <button
                className="ep-modal-btn secondary"
                onClick={() => setDeleteDepartmentsDialog(null)}
                disabled={deletingDepartments}
              >
                Отмена
              </button>
              <button
                className="ep-modal-btn danger"
                onClick={() => void confirmDeleteDepartments()}
                disabled={deletingDepartments}
              >
                {deletingDepartments ? 'Удаление...' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {employeeDialog && (
        <div className="ep-modal-overlay" onClick={() => setEmployeeDialog(null)}>
          <div className="ep-modal ep-modal-wide" onClick={event => event.stopPropagation()}>
            <div className="ep-modal-header">
              <div className="ep-modal-heading">
                <div className="ep-modal-title">
                  {employeeDialog.mode === 'edit' ? 'Редактирование сотрудника Sigur' : 'Новый сотрудник Sigur'}
                </div>
              </div>
            </div>
            <div className="ep-modal-body">
              <div className="ep-modal-stack">
                <label>
                  ФИО
                  <input
                    className="ep-modal-input"
                    value={employeeDialog.name}
                    onChange={event => setEmployeeDialog(prev => prev ? { ...prev, name: event.target.value } : prev)}
                    disabled={loadingSelectedSuggestion}
                  />
                </label>
                {employeeDialog.mode === 'create' && employeeNameSuggestionsEnabled && (employeeNameSuggestionsResult.isFetching || employeeNameSuggestions.length > 0) && (
                  <div className="sigur-emp-suggestions">
                    <div className="sigur-emp-suggestions-hint">
                      {employeeNameSuggestionsResult.isFetching
                        ? 'Поиск в Sigur...'
                        : `Найдены похожие в Sigur (${employeeNameSuggestions.length}). Кликните, чтобы редактировать.`}
                    </div>
                    {employeeNameSuggestions.map(suggestion => (
                      <button
                        key={suggestion.id}
                        type="button"
                        className="sigur-emp-suggestion-row"
                        onClick={() => void handleSelectEmployeeSuggestion(suggestion)}
                        disabled={loadingSelectedSuggestion}
                      >
                        <span className="sigur-emp-suggestion-name">{suggestion.name}</span>
                        <span className="sigur-emp-suggestion-meta">
                          {[suggestion.departmentName, suggestion.positionName, suggestion.tabId ? `Таб. ${suggestion.tabId}` : null]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <label>
                  Отдел
                  <select
                    className="ep-modal-select"
                    value={employeeDialog.departmentId}
                    onChange={event => setEmployeeDialog(prev => prev ? { ...prev, departmentId: event.target.value } : prev)}
                  >
                    <option value="">—</option>
                    {departmentOptions.map(option => (
                      <option key={option.id} value={option.id}>
                        {'\u00A0\u00A0'.repeat(option.level)}{option.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Должность
                  <select
                    className="ep-modal-select"
                    value={employeeDialog.positionId}
                    onChange={event => setEmployeeDialog(prev => prev ? { ...prev, positionId: event.target.value } : prev)}
                  >
                    <option value="">—</option>
                    {positions.map(position => (
                      <option key={position.id} value={position.id}>{position.name}</option>
                    ))}
                  </select>
                </label>
                {canEdit && (
                  <div className="sigur-live-inline-create">
                    <input
                      className="ep-modal-input"
                      value={newEmployeePositionName}
                      onChange={event => setNewEmployeePositionName(event.target.value)}
                      placeholder="Новая должность..."
                      disabled={creatingEmployeePosition || savingEmployee}
                    />
                    <button
                      className="ep-modal-btn secondary"
                      type="button"
                      onClick={() => void handleCreateEmployeePosition()}
                      disabled={creatingEmployeePosition || savingEmployee}
                    >
                      {creatingEmployeePosition ? 'Создание...' : 'Создать'}
                    </button>
                  </div>
                )}
                <label>
                  Табельный номер
                  <input
                    className="ep-modal-input"
                    value={employeeDialog.tabId}
                    onChange={event => setEmployeeDialog(prev => prev ? { ...prev, tabId: event.target.value } : prev)}
                  />
                </label>
                <label>
                  Описание
                  <textarea
                    className="ep-modal-input"
                    value={employeeDialog.description}
                    onChange={event => setEmployeeDialog(prev => prev ? { ...prev, description: event.target.value } : prev)}
                    rows={4}
                  />
                </label>
                <label className="sigur-live-checkbox-row">
                  <input
                    type="checkbox"
                    checked={employeeDialog.blocked}
                    onChange={event => setEmployeeDialog(prev => prev ? { ...prev, blocked: event.target.checked } : prev)}
                  />
                  <span>Сразу создать в заблокированном состоянии</span>
                </label>
              </div>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" onClick={() => setEmployeeDialog(null)}>
                Отмена
              </button>
              <button className="ep-modal-btn primary" onClick={() => void handleSaveEmployee()} disabled={savingEmployee || loadingSelectedSuggestion}>
                {employeeDialog.mode === 'edit'
                  ? (savingEmployee ? 'Сохранение...' : 'Сохранить')
                  : (savingEmployee ? 'Создание...' : 'Создать')}
              </button>
            </div>
          </div>
        </div>
      )}

      {employeeMoveDialog && (
        <div className="ep-modal-overlay" onClick={() => { if (!savingEmployeeMove) setEmployeeMoveDialog(null); }}>
          <div className="ep-modal" onClick={event => event.stopPropagation()}>
            <div className="ep-modal-header">
              <div className="ep-modal-heading">
                <div className="ep-modal-title">{`Переместить ${employeeMoveDialog.employeeIds.length} сотрудников`}</div>
              </div>
            </div>
            <div className="ep-modal-body">
              <label>
                Целевой отдел
                <select
                  className="ep-modal-select"
                  value={employeeMoveDialog.departmentId}
                  onChange={event => setEmployeeMoveDialog(prev => prev ? { ...prev, departmentId: event.target.value } : prev)}
                  disabled={savingEmployeeMove}
                >
                  <option value="">—</option>
                  {departmentOptions.map(option => (
                    <option key={option.id} value={option.id}>
                      {'\u00A0\u00A0'.repeat(option.level)}{option.name}
                    </option>
                  ))}
                </select>
              </label>
              {savingEmployeeMove && moveProgress && (
                <ProgressBar
                  label={moveProgress.failed > 0
                    ? `Перенос сотрудников (ошибок: ${moveProgress.failed})`
                    : 'Перенос сотрудников'}
                  current={moveProgress.processed}
                  total={moveProgress.total}
                />
              )}
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" onClick={() => setEmployeeMoveDialog(null)} disabled={savingEmployeeMove}>
                Отмена
              </button>
              <button className="ep-modal-btn primary" onClick={() => void handleSaveEmployeeMove()} disabled={savingEmployeeMove}>
                {savingEmployeeMove ? 'Перемещение...' : 'Переместить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
