import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronR, Download, Search, CheckSquare, Square } from 'lucide-react';
import { useStructureTree } from '../../hooks/useStructure';
import { timesheetService } from '../../services/timesheetService';
import { getMonthLabel } from '../../utils/calendarUtils';
import { formatTimesheetHalfLabel, type TimesheetApprovalHalf } from '../../utils/timesheetApprovalPeriod';
import type { OrgDepartmentNode } from '../../types';
import { filterDepartmentTree, sortDepartmentTree } from '../../utils/departmentUtils';
import './MassTimesheetExportPage.css';

type TimesheetDisplaySegment = TimesheetApprovalHalf | 'FULL';
type TimesheetGroupingMode = 'employees' | 'objects';
type TimesheetExportPresentation = 'hr' | 'manager';

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
const EMPTY_DEPARTMENTS: OrgDepartmentNode[] = [];

const toMonthIndex = (year: number, month: number): number => year * 12 + month - 1;

const resolveDefaultSegment = (year: number, month: number, now: Date): TimesheetDisplaySegment => {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();
  const currentMonthIndex = toMonthIndex(currentYear, currentMonth);
  const selectedMonthIndex = toMonthIndex(year, month);

  if (selectedMonthIndex < currentMonthIndex) return 'FULL';
  if (selectedMonthIndex === currentMonthIndex && currentDay > 15) return 'H2';
  return 'H1';
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

export const MassTimesheetExportPage: FC = () => {
  const now = useMemo(() => new Date(), []);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [segmentOverride, setSegmentOverride] = useState<TimesheetDisplaySegment | null>(null);
  const [groupBy, setGroupBy] = useState<TimesheetGroupingMode>('employees');
  const [exportAs1C, setExportAs1C] = useState(false);
  const [presentation, setPresentation] = useState<TimesheetExportPresentation>('hr');
  const [searchQuery, setSearchQuery] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
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
    [sortedDepartments, searchQuery]
  );

  const filteredIds = useMemo(() => collectAllIds(filteredDepts), [filteredDepts]);
  const filteredBrigadeIds = useMemo(() => collectBrigadeIds(filteredDepts), [filteredDepts]);
  const activeSegment = useMemo<TimesheetDisplaySegment>(
    () => segmentOverride ?? resolveDefaultSegment(year, month, now),
    [segmentOverride, year, month, now],
  );

  useEffect(() => {
    setSegmentOverride(null);
  }, [year, month]);

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
  const handleSegmentChange = useCallback((segment: TimesheetDisplaySegment) => {
    setSegmentOverride(segment);
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

  // Собираем только leaf-отделы (без детей) или все отмеченные
  const selectedDeptIds = useMemo(() => {
    return [...checkedIds];
  }, [checkedIds]);

  const handleExport = async (presentationOverride?: TimesheetExportPresentation) => {
    if (selectedDeptIds.length === 0) return;
    const effectivePresentation = presentationOverride ?? presentation;
    setPresentation(effectivePresentation);
    setExporting(true);
    setError(null);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.exportMass({
        month: monthStr,
        department_ids: selectedDeptIds,
        half: activeSegment,
        group_by: groupBy,
        presentation: effectivePresentation,
        export_as_1c: exportAs1C,
      });
      const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
        'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
      const daysInMonth = new Date(year, month, 0).getDate();
      const segmentSuffix = activeSegment === 'FULL'
        ? ''
        : `_${activeSegment === 'H1' ? '1-15' : `16-${daysInMonth}`}`;
      const groupingSuffix = groupBy === 'objects' ? '_по_объектам' : '';
      const templateSuffix = exportAs1C ? '_1С' : '';
      const presentationSuffix = effectivePresentation === 'manager' ? '_Руководитель' : '';
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
    <div className="mte-page">
      <div className="mte-header">
        <h2 className="mte-title">Массовый экспорт</h2>
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

      <section className="mte-half-switch" aria-label="Период выгрузки табелей">
        {(['H1', 'H2'] as TimesheetApprovalHalf[]).map(half => (
          <button
            key={half}
            type="button"
            className={`mte-half-chip ${activeSegment === half ? ' mte-half-chip--active' : ''}`}
            onClick={() => handleSegmentChange(half)}
          >
            <span className="mte-half-chip-label">{formatTimesheetHalfLabel(half, year, month)}</span>
            <span className="mte-half-chip-subtitle">
              {half === 'H1' ? 'Первая половина' : 'Вторая половина'}
            </span>
          </button>
        ))}
        <button
          type="button"
          className={`mte-half-chip ${activeSegment === 'FULL' ? ' mte-half-chip--active' : ''}`}
          onClick={() => handleSegmentChange('FULL')}
        >
          <span className="mte-half-chip-label">Весь месяц</span>
          <span className="mte-half-chip-subtitle">Полный табель</span>
        </button>
      </section>

      <section className="mte-mode-switch" aria-label="Формат выгрузки">
        <button
          type="button"
          className={`mte-mode-chip ${groupBy === 'employees' ? ' mte-mode-chip--active' : ''}`}
          onClick={() => setGroupBy('employees')}
        >
          <span className="mte-mode-chip-label">По сотрудникам</span>
          <span className="mte-mode-chip-subtitle">Один файл на выбранный отдел</span>
        </button>
        <button
          type="button"
          className={`mte-mode-chip ${groupBy === 'objects' ? ' mte-mode-chip--active' : ''}`}
          onClick={() => setGroupBy('objects')}
        >
          <span className="mte-mode-chip-label">По объектам</span>
          <span className="mte-mode-chip-subtitle">Отдельный файл на каждый объект</span>
        </button>
      </section>

      <section className="mte-export-options" aria-label="Дополнительные параметры экспорта">
        <label className={`mte-checkbox ${exportAs1C ? 'mte-checkbox--checked' : ''}`}>
          <input
            type="checkbox"
            checked={exportAs1C}
            onChange={e => setExportAs1C(e.target.checked)}
          />
          <span className="mte-checkbox-box" aria-hidden="true" />
          <span className="mte-checkbox-content">
            <span className="mte-checkbox-label">Экспорт как в 1С</span>
            <span className="mte-checkbox-subtitle">Шаблон 1С, только целые часы без доп. символов</span>
          </span>
        </label>
      </section>

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
            <button className="mte-link-btn" onClick={selectBrigades}>Выбрать бр.</button>
            <button className="mte-link-btn" onClick={deselectAll}>Снять все</button>
            <span className="mte-selected-count">
              Выбрано {checkedIds.size}
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
            className={`mte-export-btn ${presentation === 'hr' ? 'mte-export-btn--active' : ''}`}
            onClick={() => handleExport('hr')}
            disabled={exporting || checkedIds.size === 0}
          >
            <Download size={16} />
            {exporting && presentation === 'hr' ? 'Экспорт HR...' : `Экспорт HR (${checkedIds.size})`}
          </button>
          <button
            className={`mte-export-btn mte-export-btn--secondary ${presentation === 'manager' ? 'mte-export-btn--active' : ''}`}
            onClick={() => handleExport('manager')}
            disabled={exporting || checkedIds.size === 0}
          >
            <Download size={16} />
            {exporting && presentation === 'manager'
              ? 'Экспорт для руководителя...'
              : `Экспорт для руководителя (${checkedIds.size})`}
          </button>
        </div>
      </div>
    </div>
  );
};
