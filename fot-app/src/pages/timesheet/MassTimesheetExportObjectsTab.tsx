import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import { Download, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { timesheetService } from '../../services/timesheetService';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const OBJECTS_STORAGE_KEY = 'timesheet_export_objects_v1';

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

  // Фильтруем объекты по поиску
  const filteredObjects = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return objects;
    return objects.filter(obj => {
      const label = obj.alt_name?.trim() || obj.name;
      return label.toLowerCase().includes(q);
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
            const hasAltName = obj.alt_name?.trim();
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
                    {hasAltName && <div>{hasAltName}</div>}
                    {hasAltName && <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{obj.name}</div>}
                    {!hasAltName && obj.name}
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
