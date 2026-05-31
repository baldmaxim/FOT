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

type Tab = 'department' | 'brigade' | 'person' | 'object';

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
  const [draftDirectIds, setDraftDirectIds] = useState<number[]>([]);
  const [draftObjectIds, setDraftObjectIds] = useState<string[]>([]);
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

  const initialDepartmentIds = useMemo(
    () => [...new Set(employee?.assigned_department_ids || [])],
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

  // Сброс drafts при открытии новой панели/обновлении источников.
  useEffect(() => {
    if (isOpen && employee) {
      setDraftDepartmentIds(initialDepartmentIds);
      setSearchQuery('');
      setActiveTab('department');
    }
  }, [isOpen, employee, initialDepartmentIds]);

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

  const hasDepartmentChanges = !arraysEqual(draftDepartmentIds, initialDepartmentIds);
  const hasDirectChanges = !numbersEqual(draftDirectIds, initialDirectIds);
  const hasObjectChanges = !arraysEqual(draftObjectIds, initialObjectIds);
  const hasChanges = hasDepartmentChanges || hasDirectChanges || hasObjectChanges;

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

  const handleReset = () => {
    setDraftDepartmentIds(initialDepartmentIds);
    setDraftDirectIds(initialDirectIds);
    setDraftObjectIds(initialObjectIds);
    setSearchQuery('');
  };

  const handleSave = async () => {
    if (!employee || !hasChanges) return;
    setSaving(true);
    try {
      // 1) Отделы и бригады — единым массивом через существующий endpoint.
      if (hasDepartmentChanges) {
        await adminService.updateEmployeeDepartmentAccess(employee.employee_id, draftDepartmentIds);
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
      toast.success('Назначения сохранены');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-employees', 'department-access'] }),
        queryClient.invalidateQueries({ queryKey: directReportsQueryKey }),
        queryClient.invalidateQueries({ queryKey: employeeObjectsQueryKey }),
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
        </nav>

        <div className={styles.assignmentPanelBody}>
          <input
            type="text"
            placeholder={activeTab === 'person' ? 'Поиск по ФИО, должности, отделу...' : 'Поиск...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={styles.assignmentPanelSearch}
          />

          {activeTab === 'department' && (
            <DepartmentList
              departments={departmentsByKind.departments}
              search={searchQuery}
              selectedIds={draftDepartmentIds}
              onToggle={toggleDepartment}
            />
          )}

          {activeTab === 'brigade' && (
            <DepartmentList
              departments={departmentsByKind.brigades}
              search={searchQuery}
              selectedIds={draftDepartmentIds}
              onToggle={toggleDepartment}
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
  onToggle: (id: string) => void;
}> = ({ departments, search, selectedIds, onToggle }) => {
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
    const indentPx = depth * INDENT_STEP;
    return (
      <label
        key={`${keyPrefix}-${dept.id}`}
        className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}
        style={{ paddingLeft: `calc(10px + ${indentPx}px)`, ['--depth-indent' as string]: `${indentPx}px` }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(dept.id)}
        />
        <span className={styles.departmentAccessItemLabel}>
          {dept.name}
        </span>
      </label>
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
