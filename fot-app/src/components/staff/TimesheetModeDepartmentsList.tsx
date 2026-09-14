import { useMemo, useState, type FC } from 'react';
import type { ITimesheetModeDepartment } from '../../services/adminService';
import type { IFlatDepartmentOption } from '../../utils/departmentUtils';
import { formatTimesheetModeText } from './timesheetModeLabels';

interface IProps {
  kind: 'department' | 'brigade';
  /** Отделы и бригады, доступные для выбора на текущей вкладке. */
  selectable: IFlatDepartmentOption[];
  modeById: Map<string, ITimesheetModeDepartment>;
  loading: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
}

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

const SOURCE_LABEL: Record<ITimesheetModeDepartment['source'], string> = {
  department_explicit: 'задан отделу',
  legacy_department: 'по назначению офисов',
  legacy_default: 'по умолчанию',
};

/** Левая колонка вкладок «Отделы» / «Бригады». */
export const TimesheetModeDepartmentsList: FC<IProps> = ({ kind, selectable, modeById, loading, selected, onToggle }) => {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = normalize(search);
    if (!q) return selectable;
    return selectable.filter(d => normalize(d.name).includes(q));
  }, [selectable, search]);

  // Поиск выбор НЕ сбрасывает, но спрятанные им строки показываем числом.
  const hiddenSelected = useMemo(() => {
    const visibleIds = new Set(filtered.map(d => d.id));
    let count = 0;
    for (const id of selected) if (!visibleIds.has(id)) count++;
    return count;
  }, [filtered, selected]);

  const renderRow = (d: IFlatDepartmentOption) => {
    const row = modeById.get(d.id);
    const isOn = selected.has(d.id);
    return (
      <label key={d.id} className={`sc-obj-item sc-mode-row ${isOn ? 'sc-obj-item--on' : ''}`}>
        <input type="checkbox" checked={isOn} onChange={() => onToggle(d.id)} />
        <span className="sc-mode-row-body">
          <span className="sc-mode-row-head">
            <span className="sc-mode-row-name">{d.name}</span>
            {row && (
              <span className="sc-mode-row-count">
                {row.employees_count} чел.
                {row.personal_mode_count > 0 && `, из них ${row.personal_mode_count} с личным режимом`}
              </span>
            )}
          </span>
          {row ? (
            <span className="sc-mode-row-current">
              Сейчас: {formatTimesheetModeText(row.effective_mode, row.object_name)}
              {row.source === 'department_explicit' ? (
                <span className="sc-mode-source sc-mode-source--explicit">{SOURCE_LABEL[row.source]}</span>
              ) : (
                <span className="sc-mode-source">{SOURCE_LABEL[row.source]}</span>
              )}
              {row.effective_mode === 'object' && row.object_is_active === false && (
                <span className="sc-mode-inactive">объект неактивен</span>
              )}
            </span>
          ) : (
            <span className="sc-mode-row-current sc-muted">Режим недоступен</span>
          )}
        </span>
      </label>
    );
  };

  return (
    <>
      <div className="sc-obj-col-label">
        {kind === 'department' ? 'Отделы' : 'Бригады'}{selected.size > 0 ? ` — выбрано ${selected.size}` : ''}
        {hiddenSelected > 0 ? `, скрыто поиском ${hiddenSelected}` : ''}
      </div>
      <input
        type="text"
        className="sc-obj-search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Поиск по названию…"
      />
      {loading ? (
        <div className="sc-obj-empty">Загрузка…</div>
      ) : filtered.length === 0 ? (
        <div className="sc-obj-empty">— ничего не найдено —</div>
      ) : (
        <div className="sc-obj-list">{filtered.map(renderRow)}</div>
      )}
    </>
  );
};
