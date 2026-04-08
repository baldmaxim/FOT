import { type FC, useState, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronR, Download, Search, CheckSquare, Square } from 'lucide-react';
import { useStructureTree } from '../../hooks/useStructure';
import { timesheetService } from '../../services/timesheetService';
import { getMonthLabel } from '../../utils/calendarUtils';
import type { OrgDepartmentNode } from '../../types';
import './MassTimesheetExportPage.css';

interface ICheckedState {
  checkedIds: Set<string>;
}

const collectAllIds = (nodes: OrgDepartmentNode[]): string[] => {
  const ids: string[] = [];
  for (const n of nodes) {
    ids.push(n.id);
    if (n.children?.length) ids.push(...collectAllIds(n.children));
  }
  return ids;
};

const collectChildIds = (node: OrgDepartmentNode): string[] => {
  const ids: string[] = [node.id];
  for (const c of node.children || []) {
    ids.push(...collectChildIds(c));
  }
  return ids;
};

const matchesSearch = (node: OrgDepartmentNode, query: string): boolean => {
  if (node.name.toLowerCase().includes(query)) return true;
  return (node.children || []).some(c => matchesSearch(c, query));
};

const filterTree = (nodes: OrgDepartmentNode[], query: string): OrgDepartmentNode[] => {
  if (!query) return nodes;
  return nodes
    .filter(n => matchesSearch(n, query))
    .map(n => ({
      ...n,
      children: filterTree(n.children || [], query),
    }));
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
      <div className="mte-tree-row">
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

export const MassTimesheetExportPage: FC = () => {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [searchQuery, setSearchQuery] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: structure, isLoading } = useStructureTree();
  const departments = structure?.departments || [];

  const filteredDepts = useMemo(
    () => filterTree(departments, searchQuery.toLowerCase().trim()),
    [departments, searchQuery]
  );

  const filteredIds = useMemo(() => collectAllIds(filteredDepts), [filteredDepts]);

  const prevMonth = useCallback(() => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }, [month]);

  const nextMonth = useCallback(() => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }, [month]);

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
  const deselectAll = () => setCheckedIds(prev => {
    const next = new Set(prev);
    for (const id of filteredIds) next.delete(id);
    return next;
  });

  // Собираем только leaf-отделы (без детей) или все отмеченные
  const selectedDeptIds = useMemo(() => {
    return [...checkedIds];
  }, [checkedIds]);

  const handleExport = async () => {
    if (selectedDeptIds.length === 0) return;
    setExporting(true);
    setError(null);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.exportMass({
        month: monthStr,
        department_ids: selectedDeptIds,
      });
      const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
        'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
      const filename = `Табели_${MONTH_NAMES[month]}_${year}.zip`;
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
    <div className="mte-page">
      <div className="mte-header">
        <h1 className="mte-title">Массовый экспорт табелей</h1>
        <div className="mte-month-nav">
          <button className="mte-month-btn" onClick={prevMonth}>
            <ChevronLeft size={16} />
          </button>
          <span className="mte-month-label">{getMonthLabel(year, month)}</span>
          <button className="mte-month-btn" onClick={nextMonth}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="mte-body">
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
            <button className="mte-link-btn" onClick={deselectAll}>Снять все</button>
            <span className="mte-selected-count">
              Выбрано: {checkedIds.size}
            </span>
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

        {error && (
          <div className="mte-error">{error}</div>
        )}

        <div className="mte-footer">
          <button
            className="mte-export-btn"
            onClick={handleExport}
            disabled={exporting || checkedIds.size === 0}
          >
            <Download size={16} />
            {exporting ? 'Экспорт...' : `Экспорт (${checkedIds.size})`}
          </button>
        </div>
      </div>
    </div>
  );
};
