import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight as ChevronR,
  Download,
  Search,
  CheckSquare,
  Square,
} from 'lucide-react';
import { useStructureTree } from '../../hooks/useStructure';
import { timesheetService } from '../../services/timesheetService';
import type { OrgDepartmentNode } from '../../types';
import { filterDepartmentTree, sortDepartmentTree } from '../../utils/departmentUtils';

type TimesheetDisplaySegment = 'H1' | 'H2' | 'FULL';
type TimesheetGroupingMode = 'employees' | 'objects';
type TimesheetExportPresentation = 'hr' | 'manager';

const DEPARTMENTS_STORAGE_KEY = 'timesheet_export_departments_v1';
const EMPTY_DEPARTMENTS: OrgDepartmentNode[] = [];

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const collectAllIds = (nodes: OrgDepartmentNode[]): string[] => {
  const ids: string[] = [];
  for (const n of nodes) {
    ids.push(n.id);
    if (n.children?.length) ids.push(...collectAllIds(n.children));
  }
  return ids;
};

const collectBrigadeIds = (nodes: OrgDepartmentNode[]): string[] => {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.name.toLowerCase().startsWith('бр.')) {
      ids.push(node.id);
    }
    if (node.children?.length) {
      ids.push(...collectBrigadeIds(node.children));
    }
  }
  return ids;
};

const loadStoredDepartmentIds = (): Set<string> => {
  try {
    const raw = localStorage.getItem(DEPARTMENTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
};

const saveStoredDepartmentIds = (ids: Set<string>): void => {
  try {
    localStorage.setItem(DEPARTMENTS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // QuotaExceededError / SecurityError — игнорируем
  }
};

interface IDeptTreeNodeProps {
  node: OrgDepartmentNode;
  checkedIds: Set<string>;
  onToggle: (ids: string[], checked: boolean) => void;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
}

const DeptTreeNode: FC<IDeptTreeNodeProps> = ({ node, checkedIds, onToggle, expandedIds, onToggleExpand }) => {
  const isChecked = checkedIds.has(node.id);
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isBrigade = node.name.toLowerCase().startsWith('бр.');

  const handleCheck = () => {
    onToggle([node.id], !isChecked);
  };

  const CheckIcon = isChecked ? CheckSquare : Square;

  return (
    <div className="mte-tree-node">
      <div className={`mte-tree-row ${isChecked ? 'mte-tree-row--checked' : ''}`}>
        {hasChildren ? (
          <button className="mte-tree-expand" onClick={() => onToggleExpand(node.id)}>
            {isExpanded ? <ChevronDown size={14} /> : <ChevronR size={14} />}
          </button>
        ) : (
          <span className="mte-tree-expand mte-tree-expand--placeholder" />
        )}
        <button className="mte-tree-check" onClick={handleCheck}>
          <CheckIcon size={18} className={isChecked ? 'mte-check-active' : 'mte-check-inactive'} />
        </button>
        <span className="mte-tree-name" onClick={handleCheck}>
          {node.name}
          {isBrigade && <span className="mte-badge-brigade">бр.</span>}
        </span>
      </div>
      {hasChildren && isExpanded && (
        <div className="mte-tree-children">
          {node.children.map(c => (
            <DeptTreeNode
              key={c.id}
              node={c}
              checkedIds={checkedIds}
              onToggle={onToggle}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface IMassTimesheetExportDepartmentsTabProps {
  year: number;
  month: number;
  activeSegment: TimesheetDisplaySegment;
  groupBy: TimesheetGroupingMode;
  exportAs1C: boolean;
}

export const MassTimesheetExportDepartmentsTab: FC<IMassTimesheetExportDepartmentsTabProps> = ({
  year,
  month,
  activeSegment,
  groupBy,
  exportAs1C,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => loadStoredDepartmentIds());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [presentation, setPresentation] = useState<TimesheetExportPresentation>('hr');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: structure, isLoading } = useStructureTree();
  const departments = structure?.departments ?? EMPTY_DEPARTMENTS;
  const sortedDepartments = useMemo(
    () => sortDepartmentTree(departments),
    [departments],
  );

  const filteredDepts = useMemo(
    () => filterDepartmentTree(sortedDepartments, searchQuery.toLowerCase().trim()),
    [sortedDepartments, searchQuery],
  );

  const filteredIds = useMemo(() => collectAllIds(filteredDepts), [filteredDepts]);
  const filteredBrigadeIds = useMemo(() => collectBrigadeIds(filteredDepts), [filteredDepts]);

  useEffect(() => {
    saveStoredDepartmentIds(checkedIds);
  }, [checkedIds]);

  const allStructureIds = useMemo(() => collectAllIds(sortedDepartments), [sortedDepartments]);
  useEffect(() => {
    if (!structure || allStructureIds.length === 0) return;
    setCheckedIds(prev => {
      const validIds = new Set(allStructureIds);
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [structure, allStructureIds]);

  const handleToggle = useCallback((ids: string[], checked: boolean) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id); else next.delete(id);
      }
      return next;
    });
  }, []);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAll = () => setCheckedIds(prev => {
    const next = new Set(prev);
    for (const id of filteredIds) next.add(id);
    return next;
  });
  const selectBrigades = () => setCheckedIds(prev => {
    const next = new Set(prev);
    for (const id of filteredBrigadeIds) next.add(id);
    return next;
  });
  const deselectAll = () => setCheckedIds(prev => {
    const next = new Set(prev);
    for (const id of filteredIds) next.delete(id);
    return next;
  });

  const selectedDeptIds = useMemo(() => [...checkedIds], [checkedIds]);

  const handleExport = async (presentationOverride: TimesheetExportPresentation) => {
    if (selectedDeptIds.length === 0) return;
    setPresentation(presentationOverride);
    setExporting(true);
    setError(null);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.exportMass({
        month: monthStr,
        department_ids: selectedDeptIds,
        half: activeSegment,
        group_by: groupBy,
        presentation: presentationOverride,
        export_as_1c: exportAs1C,
      });
      const daysInMonth = new Date(year, month, 0).getDate();
      const segmentSuffix = activeSegment === 'FULL'
        ? ''
        : `_${activeSegment === 'H1' ? '1-15' : `16-${daysInMonth}`}`;
      const groupingSuffix = groupBy === 'objects' ? '_по_объектам' : '';
      const templateSuffix = exportAs1C ? '_1С' : '';
      const presentationSuffix = presentationOverride === 'manager' ? '_Руководитель' : '';
      const filename = `Табели${groupingSuffix}${templateSuffix}_${MONTH_NAMES[month]}_${year}${segmentSuffix}${presentationSuffix}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Mass export error:', err);
      setError('Ошибка экспорта. Попробуйте ещё раз.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="mte-controls">
        <div className="mte-search-wrap">
          <Search size={16} className="mte-search-icon" />
          <input
            className="mte-search"
            placeholder="Поиск отдела..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="mte-bulk-actions">
          <button className="mte-link-btn" onClick={selectAll}>Выбрать все</button>
          <button className="mte-link-btn" onClick={selectBrigades}>Выбрать бр.</button>
          <button className="mte-link-btn" onClick={deselectAll}>Снять все</button>
          <span className="mte-selected-count">Выбрано {checkedIds.size}</span>
        </div>
      </div>

      <div className="mte-tree-container">
        {isLoading ? (
          <div className="mte-loading">Загрузка отделов...</div>
        ) : filteredDepts.length === 0 ? (
          <div className="mte-empty">Отделы не найдены</div>
        ) : (
          filteredDepts.map(d => (
            <DeptTreeNode
              key={d.id}
              node={d}
              checkedIds={checkedIds}
              onToggle={handleToggle}
              expandedIds={expandedIds}
              onToggleExpand={handleToggleExpand}
            />
          ))
        )}
      </div>

      {exporting && (
        <div className="mte-progress">
          <div className="mte-spinner" />
          <span>Генерация табелей ({checkedIds.size} отд.)... Это может занять некоторое время</span>
        </div>
      )}

      {error && <div className="mte-error">{error}</div>}

      <div className="mte-footer">
        <button
          className={`mte-export-btn ${presentation === 'hr' ? 'mte-export-btn--active' : ''}`}
          onClick={() => handleExport('hr')}
          disabled={exporting || checkedIds.size === 0}
        >
          <Download size={16} />
          {exporting && presentation === 'hr' ? 'Выгрузить Факт...' : `Выгрузить Факт (${checkedIds.size})`}
        </button>
        <button
          className={`mte-export-btn mte-export-btn--secondary ${presentation === 'manager' ? 'mte-export-btn--active' : ''}`}
          onClick={() => handleExport('manager')}
          disabled={exporting || checkedIds.size === 0}
        >
          <Download size={16} />
          {exporting && presentation === 'manager'
            ? 'Выгрузить урезанный...'
            : `Выгрузить урезанный (${checkedIds.size})`}
        </button>
      </div>
    </>
  );
};
