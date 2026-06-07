import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  adminService,
  type EmployeeDepartmentAssignmentFromApi,
} from '../../services/adminService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import { directReportsService, type IDirectReport } from '../../services/directReportsService';
import {
  weekendApprovalService,
  type IWeekendEligibleEmployee,
  type IWeekendResponsibleData,
} from '../../services/weekendApprovalService';
import { correctionApprovalService } from '../../services/correctionApprovalService';
import { ApiError } from '../../api/client';
import { getTreeFlatDepartments, type IFlatDepartmentOption } from '../../utils/departmentUtils';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import styles from '../../pages/admin/Admin.module.css';

const AUTO_EXPAND_ALL_THRESHOLD = 40;
const INDENT_STEP = 16;

interface IEmployeeAssignmentPanelProps {
  isOpen: boolean;
  employee: EmployeeDepartmentAssignmentFromApi | null;
  allEmployees: EmployeeDepartmentAssignmentFromApi[];
  onClose: () => void;
  onSaved: () => void;
}

type Tab = 'department' | 'brigade' | 'person' | 'object' | 'weekend';

const normalizeText = (value: string | null | undefined): string => (
  String(value || '')
    .replace(/ /g, ' ')
    .replace(/ё/giu, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
);

const arraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((v, i) => v === b[i]);
};

const numbersEqual = (left: number[], right: number[]): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((v, i) => v === b[i]);
};

export const EmployeeAssignmentPanel: FC<IEmployeeAssignmentPanelProps> = ({
  isOpen,
  employee,
  allEmployees,
  onClose,
  onSaved,
}) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const structureQuery = useStructureTree();
  const [activeTab, setActiveTab] = useState<Tab>('department');
  const [searchQuery, setSearchQuery] = useState('');
  const [draftDepartmentIds, setDraftDepartmentIds] = useState<string[]>([]);
  // Подмножество draftDepartmentIds, помеченное «только просмотр» (миграция 167).
  const [draftViewOnlyIds, setDraftViewOnlyIds] = useState<string[]>([]);
  const [draftDirectIds, setDraftDirectIds] = useState<number[]>([]);
  const [draftObjectIds, setDraftObjectIds] = useState<string[]>([]);
  // Вкладка «Выходные»: ответственность за согласование работы в выходной.
  const [draftWeekendDeptIds, setDraftWeekendDeptIds] = useState<string[]>([]);
  const [draftWeekendEmpIds, setDraftWeekendEmpIds] = useState<number[]>([]);
  const [weekendMode, setWeekendMode] = useState<'department' | 'employee'>('department');
  const [weekendShowFree, setWeekendShowFree] = useState(false);
  const [saving, setSaving] = useState(false);

  const directReportsQueryKey = ['admin-direct-reports', employee?.employee_id ?? 0];
  const directReportsQuery = useQuery<IDirectReport[]>({
    queryKey: directReportsQueryKey,
    queryFn: () => (employee ? directReportsService.list({ managerEmployeeId: employee.employee_id }) : Promise.resolve([])),
    enabled: !!employee && isOpen,
    staleTime: 30_000,
  });

  const skudObjectsQuery = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['admin-skud-objects-list'],
    queryFn: () => adminService.listSkudObjectsForAssignment(),
    enabled: isOpen,
    staleTime: 5 * 60_000,
  });

  const employeeObjectsQueryKey = ['admin-employee-skud-objects', employee?.employee_id ?? 0];
  const employeeObjectsQuery = useQuery<{ object_ids: string[] }>({
    queryKey: employeeObjectsQueryKey,
    queryFn: () => (employee
      ? adminService.getEmployeeSkudObjects(employee.employee_id)
      : Promise.resolve({ object_ids: [] })),
    enabled: !!employee && isOpen,
    staleTime: 30_000,
  });

  // Вкладка «Выходные»: whitelist-отделы, назначения ответственного, кандидаты-сотрудники.
  const whitelistQuery = useQuery<string[]>({
    queryKey: ['correction-approval-whitelist'],
    queryFn: () => correctionApprovalService.getSettings().then(s => s.requiredDepartmentIds),
    enabled: isOpen,
    staleTime: 5 * 60_000,
  });
  const weekendQueryKey = ['admin-weekend-approvals', employee?.employee_id ?? 0];
  const weekendQuery = useQuery<IWeekendResponsibleData>({
    queryKey: weekendQueryKey,
    queryFn: () => (employee
      ? weekendApprovalService.getByResponsible(employee.employee_id)
      : Promise.resolve({ department_ids: [], employee_ids: [], assignments: { departments: {}, employees: {} } })),
    enabled: !!employee && isOpen,
    staleTime: 30_000,
  });
  const weekendEligibleQuery = useQuery<IWeekendEligibleEmployee[]>({
    queryKey: ['admin-weekend-eligible'],
    queryFn: () => weekendApprovalService.listEligible(false),
    enabled: isOpen,
    staleTime: 60_000,
  });

  const initialDepartmentIds = useMemo(
    () => [...new Set(employee?.assigned_department_ids || [])],
    [employee],
  );
  const initialViewOnlyIds = useMemo(
    () => [...new Set(employee?.view_only_department_ids || [])],
    [employee],
  );
  const initialDirectIds = useMemo(
    () => (directReportsQuery.data || []).map(r => r.subordinate_employee_id),
    [directReportsQuery.data],
  );
  const initialObjectIds = useMemo(
    () => [...(employeeObjectsQuery.data?.object_ids || [])],
    [employeeObjectsQuery.data?.object_ids],
  );
  const initialWeekendDeptIds = useMemo(
    () => [...(weekendQuery.data?.department_ids || [])],
    [weekendQuery.data?.department_ids],
  );
  const initialWeekendEmpIds = useMemo(
    () => [...(weekendQuery.data?.employee_ids || [])],
    [weekendQuery.data?.employee_ids],
  );

  // Сброс drafts при открытии новой панели/обновлении источников.
  useEffect(() => {
    if (isOpen && employee) {
      setDraftDepartmentIds(initialDepartmentIds);
      setDraftViewOnlyIds(initialViewOnlyIds);
      setSearchQuery('');
      setActiveTab('department');
      setWeekendMode('department');
      setWeekendShowFree(false);
    }
  }, [isOpen, employee, initialDepartmentIds, initialViewOnlyIds]);

  useEffect(() => {
    if (isOpen) {
      setDraftDirectIds(initialDirectIds);
    }
  }, [isOpen, initialDirectIds]);

  useEffect(() => {
    if (isOpen) {
      setDraftObjectIds(initialObjectIds);
    }
  }, [isOpen, initialObjectIds]);

  useEffect(() => {
    if (isOpen) {
      setDraftWeekendDeptIds(initialWeekendDeptIds);
      setDraftWeekendEmpIds(initialWeekendEmpIds);
    }
  }, [isOpen, initialWeekendDeptIds, initialWeekendEmpIds]);

  const flatDepts = useMemo<IFlatDepartmentOption[]>(
    () => getTreeFlatDepartments(structureQuery.data?.departments || []),
    [structureQuery.data?.departments],
  );

  const departmentsByKind = useMemo(() => {
    const departments = flatDepts.filter(d => d.kind === 'department');
    const brigades = flatDepts.filter(d => d.kind === 'brigade');
    return { departments, brigades };
  }, [flatDepts]);

  const directIdsSet = useMemo(() => new Set(draftDirectIds), [draftDirectIds]);
  const employeeMap = useMemo(
    () => new Map(allEmployees.map(e => [e.employee_id, e])),
    [allEmployees],
  );

  const personCandidates = useMemo(() => {
    if (!employee) return [];
    const search = normalizeText(searchQuery);
    const filtered = allEmployees
      .filter(e => e.employee_id !== employee.employee_id)
      .filter(e => !search
        || normalizeText(e.full_name).includes(search)
        || normalizeText(e.position_name || '').includes(search)
        || normalizeText(e.department_name || '').includes(search));
    const pinnedIds = new Set<number>([...initialDirectIds, ...draftDirectIds]);
    const pinned = filtered.filter(e => pinnedIds.has(e.employee_id));
    const rest = filtered.filter(e => !pinnedIds.has(e.employee_id));
    return [...pinned, ...rest.slice(0, 60)];
  }, [employee, allEmployees, searchQuery, initialDirectIds, draftDirectIds]);

  // === Вкладка «Выходные»: производные данные ===
  const whitelistSet = useMemo(
    () => new Set(whitelistQuery.data || []),
    [whitelistQuery.data],
  );
  // Отделы-кандидаты = whitelist-отделы (обычные отделы, не бригады).
  const weekendDeptCandidates = useMemo(() => {
    const search = normalizeText(searchQuery);
    return departmentsByKind.departments
      .filter(d => whitelistSet.has(d.id))
      .filter(d => !search || normalizeText(d.name).includes(search));
  }, [departmentsByKind.departments, whitelistSet, searchQuery]);
  // Карта «отдел/сотрудник → ответственный (employee_id)» из всех назначений.
  const weekendAssignDeptMap = weekendQuery.data?.assignments.departments ?? {};
  const weekendAssignEmpMap = weekendQuery.data?.assignments.employees ?? {};
  const eligibleById = useMemo(
    () => new Map((weekendEligibleQuery.data || []).map(e => [e.employee_id, e])),
    [weekendEligibleQuery.data],
  );
  const weekendEmpCandidates = useMemo(() => {
    if (!employee) return [];
    const search = normalizeText(searchQuery);
    let list = weekendEligibleQuery.data || [];
    if (weekendShowFree) list = list.filter(e => e.responsible_employee_id == null);
    return list.filter(e => !search
      || normalizeText(e.full_name || '').includes(search)
      || normalizeText(e.position_name || '').includes(search)
      || normalizeText(e.department_name || '').includes(search));
  }, [employee, weekendEligibleQuery.data, weekendShowFree, searchQuery]);
  // ФИО ответственного по employee_id (для подсказок «занят: X»).
  const responsibleName = useCallback((empId: number): string => (
    employeeMap.get(empId)?.full_name
    || eligibleById.get(empId)?.full_name
    || `ID ${empId}`
  ), [employeeMap, eligibleById]);

  const hasDepartmentChanges = !arraysEqual(draftDepartmentIds, initialDepartmentIds);
  const hasViewOnlyChanges = !arraysEqual(draftViewOnlyIds, initialViewOnlyIds);
  const hasDirectChanges = !numbersEqual(draftDirectIds, initialDirectIds);
  const hasObjectChanges = !arraysEqual(draftObjectIds, initialObjectIds);
  const hasWeekendChanges = !arraysEqual(draftWeekendDeptIds, initialWeekendDeptIds)
    || !numbersEqual(draftWeekendEmpIds, initialWeekendEmpIds);
  const hasChanges = hasDepartmentChanges || hasViewOnlyChanges || hasDirectChanges
    || hasObjectChanges || hasWeekendChanges;

  const handleRequestClose = useCallback(() => {
    if (hasChanges) {
      const ok = window.confirm('Есть несохранённые изменения. Закрыть без сохранения?');
      if (!ok) return;
    }
    onClose();
  }, [hasChanges, onClose]);

  const overlayHandlers = useOverlayDismiss(handleRequestClose);

  const toggleDepartment = (departmentId: string) => {
    setDraftDepartmentIds(prev => (prev.includes(departmentId)
      ? prev.filter(id => id !== departmentId)
      : [...prev, departmentId]));
    // Снятие отдела убирает его и из view-only.
    setDraftViewOnlyIds(prev => (prev.includes(departmentId)
      ? prev.filter(id => id !== departmentId)
      : prev));
  };

  const toggleViewOnly = (departmentId: string) => {
    setDraftViewOnlyIds(prev => (prev.includes(departmentId)
      ? prev.filter(id => id !== departmentId)
      : [...prev, departmentId]));
  };

  const toggleDirect = (subordinateEmployeeId: number) => {
    setDraftDirectIds(prev => (prev.includes(subordinateEmployeeId)
      ? prev.filter(id => id !== subordinateEmployeeId)
      : [...prev, subordinateEmployeeId]));
  };

  const toggleObject = (objectId: string) => {
    setDraftObjectIds(prev => (prev.includes(objectId)
      ? prev.filter(id => id !== objectId)
      : [...prev, objectId]));
  };

  const toggleWeekendDept = (departmentId: string) => {
    setDraftWeekendDeptIds(prev => (prev.includes(departmentId)
      ? prev.filter(id => id !== departmentId)
      : [...prev, departmentId]));
  };

  const toggleWeekendEmp = (employeeId: number) => {
    setDraftWeekendEmpIds(prev => (prev.includes(employeeId)
      ? prev.filter(id => id !== employeeId)
      : [...prev, employeeId]));
  };

  const handleReset = () => {
    setDraftDepartmentIds(initialDepartmentIds);
    setDraftViewOnlyIds(initialViewOnlyIds);
    setDraftDirectIds(initialDirectIds);
    setDraftObjectIds(initialObjectIds);
    setDraftWeekendDeptIds(initialWeekendDeptIds);
    setDraftWeekendEmpIds(initialWeekendEmpIds);
    setSearchQuery('');
  };

  const handleSave = async () => {
    if (!employee || !hasChanges) return;
    setSaving(true);
    try {
      // 1) Отделы и бригады — единым массивом + подмножество «только просмотр».
      if (hasDepartmentChanges || hasViewOnlyChanges) {
        await adminService.updateEmployeeDepartmentAccess(
          employee.employee_id,
          draftDepartmentIds,
          draftViewOnlyIds,
        );
      }
      // 2) Прямые подчинённые — diff: добавляемые → POST, убираемые → DELETE.
      if (hasDirectChanges) {
        const initialSet = new Set(initialDirectIds);
        const draftSet = new Set(draftDirectIds);
        const toAdd = draftDirectIds.filter(id => !initialSet.has(id));
        const toRemoveIds = (directReportsQuery.data || [])
          .filter(r => !draftSet.has(r.subordinate_employee_id))
          .map(r => r.id);

        const errors: string[] = [];
        for (const subId of toAdd) {
          try {
            await directReportsService.assign({
              managerEmployeeId: employee.employee_id,
              subordinateEmployeeId: subId,
            });
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              const sub = employeeMap.get(subId);
              errors.push(`${sub?.full_name || `ID ${subId}`} уже назначен другому`);
            } else {
              throw err;
            }
          }
        }
        for (const rowId of toRemoveIds) {
          await directReportsService.unassign(rowId);
        }
        if (errors.length > 0) {
          toast.error(errors.join('; '));
        }
      }
      // 3) Объекты — единый PUT.
      if (hasObjectChanges) {
        await adminService.updateEmployeeSkudObjectAccess(employee.employee_id, draftObjectIds);
      }
      // 4) Ответственность за выходные — полная замена таргетов.
      if (hasWeekendChanges) {
        const { conflicts } = await weekendApprovalService.setByResponsible(employee.employee_id, {
          departmentIds: draftWeekendDeptIds,
          employeeIds: draftWeekendEmpIds,
        });
        if (conflicts.length > 0) {
          toast.error(`Часть назначений уже закреплена за другим ответственным (${conflicts.length}) — пропущены`);
        }
      }
      toast.success('Назначения сохранены');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-employees', 'department-access'] }),
        queryClient.invalidateQueries({ queryKey: directReportsQueryKey }),
        queryClient.invalidateQueries({ queryKey: employeeObjectsQueryKey }),
        queryClient.invalidateQueries({ queryKey: weekendQueryKey }),
        queryClient.invalidateQueries({ queryKey: ['admin-weekend-eligible'] }),
      ]);
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen || !employee) return null;

  return (
    <div className={styles.assignmentPanelOverlay} {...overlayHandlers}>
      <aside
        className={styles.assignmentPanel}
        role="dialog"
        aria-modal="true"
      >
        <header className={styles.assignmentPanelHeader}>
          <div className={styles.assignmentPanelTitleBlock}>
            <div className={styles.assignmentPanelTitle}>{employee.full_name}</div>
            <div className={styles.assignmentPanelSubtitle}>
              {employee.position_name || 'Должность не указана'}
              {employee.department_name ? ` · ${employee.department_name}` : ''}
            </div>
          </div>
          <button
            type="button"
            className={styles.assignmentPanelClose}
            onClick={handleRequestClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </header>

        <nav className={styles.assignmentPanelTabs}>
          <button
            type="button"
            className={`${styles.assignmentPanelTab} ${activeTab === 'department' ? styles.assignmentPanelTabActive : ''}`}
            onClick={() => { setActiveTab('department'); setSearchQuery(''); }}
          >
            Отдел ({draftDepartmentIds.filter(id => departmentsByKind.departments.some(d => d.id === id)).length})
          </button>
          <button
            type="button"
            className={`${styles.assignmentPanelTab} ${activeTab === 'brigade' ? styles.assignmentPanelTabActive : ''}`}
            onClick={() => { setActiveTab('brigade'); setSearchQuery(''); }}
          >
            Бригада ({draftDepartmentIds.filter(id => departmentsByKind.brigades.some(d => d.id === id)).length})
          </button>
          <button
            type="button"
            className={`${styles.assignmentPanelTab} ${activeTab === 'person' ? styles.assignmentPanelTabActive : ''}`}
            onClick={() => { setActiveTab('person'); setSearchQuery(''); }}
          >
            Человек ({draftDirectIds.length})
          </button>
          <button
            type="button"
            className={`${styles.assignmentPanelTab} ${activeTab === 'object' ? styles.assignmentPanelTabActive : ''}`}
            onClick={() => { setActiveTab('object'); setSearchQuery(''); }}
          >
            Объекты ({draftObjectIds.length})
          </button>
          <button
            type="button"
            className={`${styles.assignmentPanelTab} ${activeTab === 'weekend' ? styles.assignmentPanelTabActive : ''}`}
            onClick={() => { setActiveTab('weekend'); setSearchQuery(''); }}
          >
            Выходные ({draftWeekendDeptIds.length + draftWeekendEmpIds.length})
          </button>
        </nav>

        <div className={styles.assignmentPanelBody}>
          {activeTab === 'weekend' && (
            <div className={styles.weekendToolbar}>
              <div className={styles.weekendModeToggle} role="tablist" aria-label="Режим назначения выходных">
                <button
                  type="button"
                  className={`${styles.weekendModeBtn} ${weekendMode === 'department' ? styles.weekendModeBtnActive : ''}`}
                  onClick={() => { setWeekendMode('department'); setWeekendShowFree(false); setSearchQuery(''); }}
                >
                  Отделы
                </button>
                <button
                  type="button"
                  className={`${styles.weekendModeBtn} ${weekendMode === 'employee' ? styles.weekendModeBtnActive : ''}`}
                  onClick={() => { setWeekendMode('employee'); setSearchQuery(''); }}
                >
                  Сотрудники
                </button>
              </div>
              {weekendMode === 'employee' && (
                <button
                  type="button"
                  className={`${styles.weekendFreeBtn} ${weekendShowFree ? styles.weekendFreeBtnActive : ''}`}
                  onClick={() => setWeekendShowFree(v => !v)}
                  title="Сотрудники без назначенного ответственного"
                >
                  Свободные
                </button>
              )}
            </div>
          )}
          <input
            type="text"
            placeholder={activeTab === 'person' || (activeTab === 'weekend' && weekendMode === 'employee')
              ? 'Поиск по ФИО, должности, отделу...'
              : 'Поиск...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={styles.assignmentPanelSearch}
          />

          {activeTab === 'department' && (
            <DepartmentList
              departments={departmentsByKind.departments}
              search={searchQuery}
              selectedIds={draftDepartmentIds}
              viewOnlyIds={draftViewOnlyIds}
              onToggle={toggleDepartment}
              onToggleViewOnly={toggleViewOnly}
            />
          )}

          {activeTab === 'brigade' && (
            <DepartmentList
              departments={departmentsByKind.brigades}
              search={searchQuery}
              selectedIds={draftDepartmentIds}
              viewOnlyIds={draftViewOnlyIds}
              onToggle={toggleDepartment}
              onToggleViewOnly={toggleViewOnly}
            />
          )}

          {activeTab === 'person' && (
            <PersonList
              candidates={personCandidates}
              selectedIdsSet={directIdsSet}
              currentManagerEmployeeId={employee.employee_id}
              onToggle={toggleDirect}
            />
          )}

          {activeTab === 'object' && (
            <ObjectList
              objects={skudObjectsQuery.data || []}
              search={searchQuery}
              selectedIds={draftObjectIds}
              onToggle={toggleObject}
              loading={skudObjectsQuery.isLoading || employeeObjectsQuery.isLoading}
            />
          )}

          {activeTab === 'weekend' && weekendMode === 'department' && (
            <WeekendDepartmentList
              departments={weekendDeptCandidates}
              selectedIds={draftWeekendDeptIds}
              assignmentMap={weekendAssignDeptMap}
              currentResponsibleId={employee.employee_id}
              responsibleName={responsibleName}
              onToggle={toggleWeekendDept}
              loading={whitelistQuery.isLoading || structureQuery.isLoading}
            />
          )}

          {activeTab === 'weekend' && weekendMode === 'employee' && (
            <WeekendPersonList
              candidates={weekendEmpCandidates}
              selectedIds={draftWeekendEmpIds}
              assignmentMap={weekendAssignEmpMap}
              currentResponsibleId={employee.employee_id}
              responsibleName={responsibleName}
              onToggle={toggleWeekendEmp}
              loading={weekendEligibleQuery.isLoading}
              showFree={weekendShowFree}
            />
          )}
        </div>

        <footer className={styles.assignmentPanelFooter}>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={handleReset}
            disabled={!hasChanges || saving}
          >
            Сбросить
          </button>
          <button
            type="button"
            className={styles.saveBtn}
            onClick={() => void handleSave()}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Сохраняю...' : 'Сохранить'}
          </button>
        </footer>
      </aside>
    </div>
  );
};

const DepartmentList: FC<{
  departments: IFlatDepartmentOption[];
  search: string;
  selectedIds: string[];
  viewOnlyIds: string[];
  onToggle: (id: string) => void;
  onToggleViewOnly: (id: string) => void;
}> = ({ departments, search, selectedIds, viewOnlyIds, onToggle, onToggleViewOnly }) => {
  const normalizedSearch = normalizeText(search);

  // Глубина для рендера = level - minLevel: фильтрация по kind / скрытие корней
  // даёт постоянный сдвиг, нормализуем самый мелкий видимый узел к 0.
  const minLevel = useMemo(
    () => (departments.length ? Math.min(...departments.map(d => d.level)) : 0),
    [departments],
  );

  // child→parent (ближайший предок) по плоскому массиву через стек: предок
  // имеет level < n.level и идёт раньше в обходе.
  const parentMap = useMemo(() => {
    const map = new Map<string, string>();
    const stack: IFlatDepartmentOption[] = [];
    for (const node of departments) {
      while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
        stack.pop();
      }
      if (stack.length > 0) map.set(node.id, stack[stack.length - 1].id);
      stack.push(node);
    }
    return map;
  }, [departments]);

  const initialExpansion = useMemo(() => {
    if (departments.length === 0) return new Set<string>();
    if (departments.length <= AUTO_EXPAND_ALL_THRESHOLD) {
      return new Set(departments.filter(d => d.hasChildren).map(d => d.id));
    }
    const result = new Set<string>();
    for (const id of selectedIds) {
      let cur = parentMap.get(id);
      while (cur && !result.has(cur)) {
        result.add(cur);
        cur = parentMap.get(cur);
      }
    }
    return result;
  }, [departments, selectedIds, parentMap]);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(initialExpansion);
  const initialAppliedRef = useRef(departments.length > 0);

  // Departments прилетают асинхронно (structureQuery). Первая ненулевая загрузка —
  // переинициализируем раскрытие; дальше не трогаем, чтобы не перетереть toggle юзера.
  useEffect(() => {
    if (!initialAppliedRef.current && departments.length > 0) {
      initialAppliedRef.current = true;
      setExpandedIds(initialExpansion);
    }
  }, [departments.length, initialExpansion]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filtered = departments.filter(d => !normalizedSearch || normalizeText(d.name).includes(normalizedSearch));
  const selectedSet = new Set(selectedIds);
  const viewOnlySet = new Set(viewOnlyIds);

  if (filtered.length === 0) {
    return (
      <div className={styles.departmentAccessEmpty}>
        {normalizedSearch ? 'По запросу ничего не найдено' : 'Нет доступных подразделений'}
      </div>
    );
  }

  const selectedLeaves = filtered.filter(d => !d.hasChildren && selectedSet.has(d.id));
  const restRaw = filtered.filter(d => d.hasChildren || !selectedSet.has(d.id));

  // Прячем заголовки-родители, у которых после выноса выбранных не осталось видимых листьев.
  const restItems: IFlatDepartmentOption[] = [];
  for (let i = 0; i < restRaw.length; i++) {
    const item = restRaw[i];
    if (!item.hasChildren) {
      restItems.push(item);
      continue;
    }
    let hasLeafDescendant = false;
    for (let j = i + 1; j < restRaw.length; j++) {
      const next = restRaw[j];
      if (next.level <= item.level) break;
      if (!next.hasChildren) { hasLeafDescendant = true; break; }
    }
    if (hasLeafDescendant) restItems.push(item);
  }

  // При активном поиске показываем все совпадения (collapse игнорируется),
  // иначе скрываем потомков свёрнутых заголовков.
  const visibleRestItems: IFlatDepartmentOption[] = [];
  if (normalizedSearch) {
    visibleRestItems.push(...restItems);
  } else {
    const headerStack: IFlatDepartmentOption[] = [];
    for (const item of restItems) {
      while (headerStack.length > 0 && headerStack[headerStack.length - 1].level >= item.level) {
        headerStack.pop();
      }
      const ancestorCollapsed = headerStack.some(h => !expandedIds.has(h.id));
      if (!ancestorCollapsed) visibleRestItems.push(item);
      if (item.hasChildren) headerStack.push(item);
    }
  }

  const renderLeaf = (dept: IFlatDepartmentOption, keyPrefix: string, depth: number) => {
    const checked = selectedSet.has(dept.id);
    const viewOnly = viewOnlySet.has(dept.id);
    const indentPx = depth * INDENT_STEP;
    return (
      <div
        key={`${keyPrefix}-${dept.id}`}
        className={`${styles.departmentAccessItem} ${styles.departmentAccessItemRow} ${checked ? styles.departmentAccessItemChecked : ''}`}
        style={{ paddingLeft: `calc(10px + ${indentPx}px)`, ['--depth-indent' as string]: `${indentPx}px` }}
      >
        <label className={styles.departmentAccessItemMain}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onToggle(dept.id)}
          />
          <span className={styles.departmentAccessItemLabel}>
            {dept.name}
          </span>
        </label>
        {checked && (
          <button
            type="button"
            className={`${styles.viewOnlyToggle} ${viewOnly ? styles.viewOnlyToggleActive : ''}`}
            onClick={() => onToggleViewOnly(dept.id)}
            title="Только просмотр: руководитель видит сотрудников отдела, но не редактирует табель и не согласует"
          >
            {viewOnly ? 'Только просмотр' : 'Редактирование'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={styles.assignmentPanelList}>
      {selectedLeaves.length > 0 && (
        <>
          <div className={styles.departmentAccessGroupHeader}>
            Назначенные ({selectedLeaves.length})
          </div>
          {selectedLeaves.map(dept => renderLeaf(dept, 'selected', 0))}
        </>
      )}
      {visibleRestItems.map(dept => {
        const depth = dept.level - minLevel;
        if (dept.hasChildren) {
          const isExpanded = normalizedSearch ? true : expandedIds.has(dept.id);
          const indentPx = depth * INDENT_STEP;
          return (
            <button
              key={dept.id}
              type="button"
              className={`${styles.departmentAccessGroupHeader} ${styles.departmentAccessGroupHeaderToggle}`}
              style={{ paddingLeft: `calc(10px + ${indentPx}px)`, ['--depth-indent' as string]: `${indentPx}px` }}
              onClick={() => toggleExpanded(dept.id)}
              aria-expanded={isExpanded}
            >
              <span className={styles.departmentAccessGroupChevron}>
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <span>{dept.name}</span>
            </button>
          );
        }
        return renderLeaf(dept, 'rest', depth);
      })}
    </div>
  );
};

const PersonList: FC<{
  candidates: EmployeeDepartmentAssignmentFromApi[];
  selectedIdsSet: Set<number>;
  currentManagerEmployeeId: number;
  onToggle: (id: number) => void;
}> = ({ candidates, selectedIdsSet, currentManagerEmployeeId, onToggle }) => {
  if (candidates.length === 0) {
    return <div className={styles.departmentAccessEmpty}>Сотрудники не найдены</div>;
  }

  const selected = candidates.filter(c => selectedIdsSet.has(c.employee_id));
  const rest = candidates.filter(c => !selectedIdsSet.has(c.employee_id));

  const renderItem = (candidate: EmployeeDepartmentAssignmentFromApi, keyPrefix: string) => {
    const checked = selectedIdsSet.has(candidate.employee_id);
    const otherManagerId = candidate.direct_manager_employee_id ?? null;
    const isPinnedToOther = otherManagerId != null && otherManagerId !== currentManagerEmployeeId;
    const disabled = isPinnedToOther && !checked;
    return (
      <label
        key={`${keyPrefix}-${candidate.employee_id}`}
        className={`${styles.assignmentPanelPerson} ${checked ? styles.departmentAccessItemChecked : ''}`}
        aria-disabled={disabled || undefined}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle(candidate.employee_id)}
        />
        <div className={styles.assignmentPanelPersonInfo}>
          <div className={styles.assignmentPanelPersonName}>{candidate.full_name}</div>
          <div className={styles.assignmentPanelPersonMeta}>
            {candidate.position_name || 'Должность не указана'}
            {candidate.department_name ? ` · ${candidate.department_name}` : ''}
          </div>
          {isPinnedToOther && (
            <div className={styles.assignmentPanelPersonAssigned}>
              Уже назначен: {candidate.direct_manager_full_name || `ID ${otherManagerId}`}
            </div>
          )}
        </div>
      </label>
    );
  };

  return (
    <div className={styles.assignmentPanelList}>
      {selected.length > 0 && (
        <>
          <div className={styles.departmentAccessGroupHeader}>
            Назначенные ({selected.length})
          </div>
          {selected.map(c => renderItem(c, 'selected'))}
        </>
      )}
      {rest.map(c => renderItem(c, 'rest'))}
    </div>
  );
};

const ObjectList: FC<{
  objects: Array<{ id: string; name: string }>;
  search: string;
  selectedIds: string[];
  onToggle: (id: string) => void;
  loading: boolean;
}> = ({ objects, search, selectedIds, onToggle, loading }) => {
  const normalizedSearch = normalizeText(search);
  const filtered = objects.filter(o => !normalizedSearch || normalizeText(o.name).includes(normalizedSearch));
  const selectedSet = new Set(selectedIds);

  if (loading) {
    return <div className={styles.departmentAccessEmpty}>Загрузка...</div>;
  }
  if (filtered.length === 0) {
    return (
      <div className={styles.departmentAccessEmpty}>
        {normalizedSearch ? 'По запросу ничего не найдено' : 'Нет доступных объектов'}
      </div>
    );
  }

  const selected = filtered.filter(o => selectedSet.has(o.id));
  const rest = filtered.filter(o => !selectedSet.has(o.id));

  const renderItem = (obj: { id: string; name: string }, keyPrefix: string) => {
    const checked = selectedSet.has(obj.id);
    return (
      <label
        key={`${keyPrefix}-${obj.id}`}
        className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(obj.id)}
        />
        <span className={styles.departmentAccessItemLabel}>{obj.name}</span>
      </label>
    );
  };

  return (
    <div className={styles.assignmentPanelList}>
      {selected.length > 0 && (
        <>
          <div className={styles.departmentAccessGroupHeader}>
            Назначенные ({selected.length})
          </div>
          {selected.map(o => renderItem(o, 'selected'))}
        </>
      )}
      {rest.map(o => renderItem(o, 'rest'))}
    </div>
  );
};

const WeekendDepartmentList: FC<{
  departments: IFlatDepartmentOption[];
  selectedIds: string[];
  assignmentMap: Record<string, number>;
  currentResponsibleId: number;
  responsibleName: (employeeId: number) => string;
  onToggle: (id: string) => void;
  loading: boolean;
}> = ({ departments, selectedIds, assignmentMap, currentResponsibleId, responsibleName, onToggle, loading }) => {
  if (loading) {
    return <div className={styles.departmentAccessEmpty}>Загрузка...</div>;
  }
  if (departments.length === 0) {
    return (
      <div className={styles.departmentAccessEmpty}>
        Нет отделов с согласованием выходных (см. настройку «Согласование по отделам»)
      </div>
    );
  }
  const selectedSet = new Set(selectedIds);
  const selected = departments.filter(d => selectedSet.has(d.id));
  const rest = departments.filter(d => !selectedSet.has(d.id));

  const renderItem = (dept: IFlatDepartmentOption, keyPrefix: string) => {
    const checked = selectedSet.has(dept.id);
    const ownerId = assignmentMap[dept.id] ?? null;
    const ownedByOther = ownerId != null && ownerId !== currentResponsibleId;
    const disabled = ownedByOther && !checked;
    return (
      <label
        key={`${keyPrefix}-${dept.id}`}
        className={`${styles.assignmentPanelPerson} ${checked ? styles.departmentAccessItemChecked : ''}`}
        aria-disabled={disabled || undefined}
      >
        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(dept.id)} />
        <div className={styles.assignmentPanelPersonInfo}>
          <div className={styles.assignmentPanelPersonName}>{dept.name}</div>
          {ownedByOther && (
            <div className={styles.assignmentPanelPersonAssigned}>
              Закреплён: {responsibleName(ownerId!)}
            </div>
          )}
        </div>
      </label>
    );
  };

  return (
    <div className={styles.assignmentPanelList}>
      {selected.length > 0 && (
        <>
          <div className={styles.departmentAccessGroupHeader}>Назначенные ({selected.length})</div>
          {selected.map(d => renderItem(d, 'selected'))}
        </>
      )}
      {rest.map(d => renderItem(d, 'rest'))}
    </div>
  );
};

const WeekendPersonList: FC<{
  candidates: IWeekendEligibleEmployee[];
  selectedIds: number[];
  assignmentMap: Record<string, number>;
  currentResponsibleId: number;
  responsibleName: (employeeId: number) => string;
  onToggle: (id: number) => void;
  loading: boolean;
  showFree: boolean;
}> = ({ candidates, selectedIds, assignmentMap, currentResponsibleId, responsibleName, onToggle, loading, showFree }) => {
  if (loading) {
    return <div className={styles.departmentAccessEmpty}>Загрузка...</div>;
  }
  if (candidates.length === 0) {
    return (
      <div className={styles.departmentAccessEmpty}>
        {showFree ? 'Свободных сотрудников нет' : 'Сотрудники не найдены'}
      </div>
    );
  }
  const selectedSet = new Set(selectedIds);
  const selected = candidates.filter(c => selectedSet.has(c.employee_id));
  const rest = candidates.filter(c => !selectedSet.has(c.employee_id));

  const renderItem = (c: IWeekendEligibleEmployee, keyPrefix: string) => {
    const checked = selectedSet.has(c.employee_id);
    const explicitOwner = assignmentMap[String(c.employee_id)] ?? null;
    const ownedByOther = explicitOwner != null && explicitOwner !== currentResponsibleId;
    const disabled = ownedByOther && !checked;
    // Покрыт через отдел (не явным назначением сотрудника) — информативно.
    const coveredByDept = explicitOwner == null
      && c.responsible_employee_id != null
      && c.responsible_employee_id !== currentResponsibleId;
    return (
      <label
        key={`${keyPrefix}-${c.employee_id}`}
        className={`${styles.assignmentPanelPerson} ${checked ? styles.departmentAccessItemChecked : ''}`}
        aria-disabled={disabled || undefined}
      >
        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(c.employee_id)} />
        <div className={styles.assignmentPanelPersonInfo}>
          <div className={styles.assignmentPanelPersonName}>{c.full_name || `ID ${c.employee_id}`}</div>
          <div className={styles.assignmentPanelPersonMeta}>
            {c.position_name || 'Должность не указана'}
            {c.department_name ? ` · ${c.department_name}` : ''}
          </div>
          {ownedByOther && (
            <div className={styles.assignmentPanelPersonAssigned}>
              Закреплён: {responsibleName(explicitOwner!)}
            </div>
          )}
          {coveredByDept && (
            <div className={styles.assignmentPanelPersonAssigned}>
              Покрыт отделом: {responsibleName(c.responsible_employee_id!)}
            </div>
          )}
        </div>
      </label>
    );
  };

  return (
    <div className={styles.assignmentPanelList}>
      {selected.length > 0 && (
        <>
          <div className={styles.departmentAccessGroupHeader}>Назначенные ({selected.length})</div>
          {selected.map(c => renderItem(c, 'selected'))}
        </>
      )}
      {rest.map(c => renderItem(c, 'rest'))}
    </div>
  );
};
