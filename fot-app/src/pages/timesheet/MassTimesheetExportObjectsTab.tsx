import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import { Download, Search, Settings } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { timesheetService } from '../../services/timesheetService';
import { useStructureTree } from '../../hooks/useStructure';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const OBJECTS_STORAGE_KEY = 'timesheet_export_objects_v1';
const OBJECTS_DEPTS_STORAGE_KEY = 'timesheet_export_objects_depts_v1';

const loadStoredObjectIds = (): Set<string> => {
  try {
    const raw = localStorage.getItem(OBJECTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
};

const saveStoredObjectIds = (ids: Set<string>): void => {
  try {
    localStorage.setItem(OBJECTS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
};

const loadStoredDeptIds = (): Set<string> => {
  try {
    const raw = localStorage.getItem(OBJECTS_DEPTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
};

const saveStoredDeptIds = (ids: Set<string>): void => {
  try {
    localStorage.setItem(OBJECTS_DEPTS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
};

interface IMassTimesheetExportObjectsTabProps {
  year: number;
  month: number;
  rangeStart: string;
  rangeEnd: string;
}

export const MassTimesheetExportObjectsTab: FC<IMassTimesheetExportObjectsTabProps> = ({
  year,
  month,
  rangeStart,
  rangeEnd,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => loadStoredObjectIds());
  const [filterDeptIds, setFilterDeptIds] = useState<Set<string>>(() => loadStoredDeptIds());
  const [showDeptFilter, setShowDeptFilter] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: objects = [], isLoading, isError } = useQuery({
    queryKey: ['timesheetObjects'],
    queryFn: async () => {
      const result = await timesheetService.listObjects();
      return result;
    },
  });

  useEffect(() => {
    saveStoredObjectIds(checkedIds);
  }, [checkedIds]);

  useEffect(() => {
    saveStoredDeptIds(filterDeptIds);
  }, [filterDeptIds]);

  // Фильтруем объекты по поиску
  const filteredObjects = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return objects;
    return objects.filter(obj => {
      const haystack = `${obj.name} ${obj.alt_name ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [objects, searchQuery]);

  const handleToggle = useCallback((id: string, checked: boolean) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const selectAll = () => setCheckedIds(new Set(filteredObjects.map(obj => obj.id)));
  const deselectAll = () => setCheckedIds(new Set());

  const selectedObjectIds = useMemo(() => [...checkedIds], [checkedIds]);

  const handleExport = async () => {
    if (selectedObjectIds.length === 0) return;
    setExporting(true);
    setError(null);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.exportObjectsUnified({
        month: monthStr,
        object_ids: selectedObjectIds,
        from: rangeStart,
        to: rangeEnd,
        department_ids: filterDeptIds.size > 0 ? [...filterDeptIds] : undefined,
      });
      const daysInMonth = new Date(year, month, 0).getDate();
      const startDay = Number.parseInt(rangeStart.slice(-2), 10);
      const endDay = Number.parseInt(rangeEnd.slice(-2), 10);
      const isFullMonth = startDay === 1 && endDay === daysInMonth;
      const segmentSuffix = isFullMonth ? '' : `_${startDay}-${endDay}`;
      const filename = `Единый_1С_по_объектам_${MONTH_NAMES[month]}_${year}${segmentSuffix}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Objects export error:', err);
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
            placeholder="Поиск объекта..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="mte-bulk-actions">
          <button className="mte-link-btn" onClick={selectAll}>Выбрать все</button>
          <button className="mte-link-btn" onClick={deselectAll}>Снять все</button>
          <button
            className="mte-link-btn"
            onClick={() => setShowDeptFilter(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Settings size={16} />
            Настройка
            {filterDeptIds.size > 0 && <span style={{ fontSize: '12px', color: 'var(--primary)' }}>({filterDeptIds.size})</span>}
          </button>
          <span className="mte-selected-count">Выбрано {checkedIds.size}</span>
        </div>
      </div>

      <div className="mte-tree-container">
        {isError && objects.length > 0 && (
          <div className="mte-loading">Показаны последние данные.</div>
        )}
        {isLoading && objects.length === 0 ? (
          <div className="mte-loading">Загрузка объектов...</div>
        ) : isError && objects.length === 0 ? (
          <div className="mte-empty">Не удалось загрузить объекты.</div>
        ) : filteredObjects.length === 0 ? (
          <div className="mte-empty">Объекты не найдены</div>
        ) : (
          filteredObjects.map(obj => {
            const isChecked = checkedIds.has(obj.id);
            return (
              <div key={obj.id} className="mte-tree-node">
                <div className={`mte-tree-row ${isChecked ? 'mte-tree-row--checked' : ''}`}>
                  <span className="mte-tree-expand mte-tree-expand--placeholder" />
                  <button
                    className="mte-tree-check"
                    onClick={() => handleToggle(obj.id, !isChecked)}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => { /* controlled above */ }}
                      style={{ display: 'none' }}
                    />
                    <span style={{
                      display: 'block',
                      width: '18px',
                      height: '18px',
                      border: '2px solid var(--text-tertiary)',
                      borderRadius: '3px',
                      backgroundColor: isChecked ? 'var(--primary)' : 'transparent',
                    }} />
                  </button>
                  <span className="mte-tree-name" onClick={() => handleToggle(obj.id, !isChecked)}>
                    {obj.alt_name?.trim() ? `${obj.name} (${obj.alt_name.trim()})` : obj.name}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {exporting && (
        <div className="mte-progress">
          <div className="mte-spinner" />
          <span>Сборка файла (${selectedObjectIds.length} объ.)... Это может занять некоторое время</span>
        </div>
      )}

      {error && <div className="mte-error">{error}</div>}

      {showDeptFilter && (
        <DeptFilterModal
          selectedDeptIds={filterDeptIds}
          onApply={setFilterDeptIds}
          onClose={() => setShowDeptFilter(false)}
        />
      )}

      <div className="mte-footer">
        <button
          className="mte-export-btn"
          onClick={handleExport}
          disabled={exporting || checkedIds.size === 0}
        >
          <Download size={16} />
          {exporting
            ? 'Сборка единого файла…'
            : `Единый файл для 1С (${checkedIds.size})`}
        </button>
      </div>
    </>
  );
};

interface IDeptFilterModalProps {
  selectedDeptIds: Set<string>;
  onApply: (ids: Set<string>) => void;
  onClose: () => void;
}

const DeptFilterModal: FC<IDeptFilterModalProps> = ({ selectedDeptIds, onApply, onClose }) => {
  const { data: treeData } = useStructureTree();
  const tree = treeData?.departments ?? [];
  const [tempDeptIds, setTempDeptIds] = useState<Set<string>>(new Set(selectedDeptIds));
  const overlayRef = useOverlayDismiss(onClose);

  const leafDepts = useMemo(() => {
    const leaves: Array<{ id: string; name: string }> = [];
    const collect = (nodes: typeof tree): void => {
      for (const node of nodes) {
        if (!node.children || node.children.length === 0) {
          leaves.push({ id: node.id, name: node.name });
        } else {
          collect(node.children);
        }
      }
    };
    collect(tree);
    return leaves.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [tree]);

  const handleToggleDept = useCallback((deptId: string, checked: boolean) => {
    setTempDeptIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(deptId);
      else next.delete(deptId);
      return next;
    });
  }, []);

  const selectAllDepts = () => setTempDeptIds(new Set(leafDepts.map(d => d.id)));
  const deselectAllDepts = () => setTempDeptIds(new Set());

  return (
    <div className="mte-modal-overlay" {...overlayRef}>
      <div className="mte-modal" style={{ maxWidth: '500px' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: 600 }}>
            Выбор отделов для выгрузки
          </h3>
          <p style={{ margin: '0', fontSize: '13px', color: 'var(--text-secondary)' }}>
            Выбранные отделы будут включены в выгруженный файл. Если не выбрать ни одного, будут выгружены все.
          </p>
        </div>

        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', gap: '8px' }}>
          <button
            className="mte-link-btn"
            onClick={selectAllDepts}
            style={{ fontSize: '13px' }}
          >
            Выбрать все
          </button>
          <button
            className="mte-link-btn"
            onClick={deselectAllDepts}
            style={{ fontSize: '13px' }}
          >
            Снять все
          </button>
        </div>

        <div style={{
          padding: '12px 20px',
          maxHeight: '300px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          {leafDepts.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
              Отделы не загружены
            </div>
          ) : (
            leafDepts.map(dept => (
              <label
                key={dept.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '4px 0',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                <input
                  type="checkbox"
                  checked={tempDeptIds.has(dept.id)}
                  onChange={e => handleToggleDept(dept.id, e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                {dept.name}
              </label>
            ))
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            Отмена
          </button>
          <button
            onClick={() => {
              onApply(tempDeptIds);
              onClose();
            }}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              borderRadius: '4px',
              background: 'var(--primary)',
              color: 'white',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Применить
          </button>
        </div>
      </div>
    </div>
  );
};
