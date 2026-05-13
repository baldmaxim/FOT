import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminService,
  type EmployeeDepartmentAssignmentFromApi,
} from '../../services/adminService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import { directReportsService, type IDirectReport } from '../../services/directReportsService';
import { ApiError } from '../../api/client';
import { getTreeFlatDepartments, type IFlatDepartmentOption } from '../../utils/departmentUtils';
import styles from '../../pages/super-admin/SuperAdmin.module.css';

interface IEmployeeAssignmentPanelProps {
  isOpen: boolean;
  employee: EmployeeDepartmentAssignmentFromApi | null;
  allEmployees: EmployeeDepartmentAssignmentFromApi[];
  onClose: () => void;
  onSaved: () => void;
}

type Tab = 'department' | 'brigade' | 'person';

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
  const [saving, setSaving] = useState(false);

  const directReportsQueryKey = ['admin-direct-reports', employee?.employee_id ?? 0];
  const directReportsQuery = useQuery<IDirectReport[]>({
    queryKey: directReportsQueryKey,
    queryFn: () => (employee ? directReportsService.list({ managerEmployeeId: employee.employee_id }) : Promise.resolve([])),
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
    return allEmployees
      .filter(e => e.employee_id !== employee.employee_id)
      .filter(e => !search
        || normalizeText(e.full_name).includes(search)
        || normalizeText(e.position_name || '').includes(search)
        || normalizeText(e.department_name || '').includes(search))
      .slice(0, 60);
  }, [employee, allEmployees, searchQuery]);

  const hasDepartmentChanges = !arraysEqual(draftDepartmentIds, initialDepartmentIds);
  const hasDirectChanges = !numbersEqual(draftDirectIds, initialDirectIds);
  const hasChanges = hasDepartmentChanges || hasDirectChanges;

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

  const handleReset = () => {
    setDraftDepartmentIds(initialDepartmentIds);
    setDraftDirectIds(initialDirectIds);
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
      toast.success('Назначения сохранены');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-employees', 'department-access'] }),
        queryClient.invalidateQueries({ queryKey: directReportsQueryKey }),
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
    <div className={styles.assignmentPanelOverlay} onClick={onClose}>
      <aside
        className={styles.assignmentPanel}
        onClick={(e) => e.stopPropagation()}
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
            onClick={onClose}
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
              onToggle={toggleDirect}
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

  const renderLeaf = (dept: IFlatDepartmentOption, keyPrefix: string, indent: number) => {
    const checked = selectedSet.has(dept.id);
    return (
      <label
        key={`${keyPrefix}-${dept.id}`}
        className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(dept.id)}
        />
        <span
          className={styles.departmentAccessItemLabel}
          style={{ paddingLeft: `${indent * 14}px` }}
        >
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
      {restItems.map(dept => {
        if (dept.hasChildren) {
          return (
            <div
              key={dept.id}
              className={styles.departmentAccessGroupHeader}
              style={{ paddingLeft: `${dept.level * 14}px` }}
            >
              {dept.name}
            </div>
          );
        }
        return renderLeaf(dept, 'rest', dept.level);
      })}
    </div>
  );
};

const PersonList: FC<{
  candidates: EmployeeDepartmentAssignmentFromApi[];
  selectedIdsSet: Set<number>;
  onToggle: (id: number) => void;
}> = ({ candidates, selectedIdsSet, onToggle }) => {
  if (candidates.length === 0) {
    return <div className={styles.departmentAccessEmpty}>Сотрудники не найдены</div>;
  }

  const selected = candidates.filter(c => selectedIdsSet.has(c.employee_id));
  const rest = candidates.filter(c => !selectedIdsSet.has(c.employee_id));

  const renderItem = (candidate: EmployeeDepartmentAssignmentFromApi, keyPrefix: string) => {
    const checked = selectedIdsSet.has(candidate.employee_id);
    return (
      <label
        key={`${keyPrefix}-${candidate.employee_id}`}
        className={`${styles.assignmentPanelPerson} ${checked ? styles.departmentAccessItemChecked : ''}`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(candidate.employee_id)}
        />
        <div className={styles.assignmentPanelPersonInfo}>
          <div className={styles.assignmentPanelPersonName}>{candidate.full_name}</div>
          <div className={styles.assignmentPanelPersonMeta}>
            {candidate.position_name || 'Должность не указана'}
            {candidate.department_name ? ` · ${candidate.department_name}` : ''}
          </div>
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
