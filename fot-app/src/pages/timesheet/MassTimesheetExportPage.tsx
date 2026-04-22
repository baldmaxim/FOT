import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getMonthLabel } from '../../utils/calendarUtils';
import { MassTimesheetExportDepartmentsTab } from './MassTimesheetExportDepartmentsTab';
import { MassTimesheetExportAssignedTab } from './MassTimesheetExportAssignedTab';
import './MassTimesheetExportPage.css';

type TimesheetGroupingMode = 'employees' | 'objects';
type ExportTab = 'departments' | 'assigned';

const ACTIVE_TAB_STORAGE_KEY = 'timesheet_export_active_tab_v1';

const pad2 = (value: number): string => String(value).padStart(2, '0');

const getMonthRange = (year: number, month: number): { first: string; last: string; daysInMonth: number } => {
  const daysInMonth = new Date(year, month, 0).getDate();
  return {
    first: `${year}-${pad2(month)}-01`,
    last: `${year}-${pad2(month)}-${pad2(daysInMonth)}`,
    daysInMonth,
  };
};

const loadStoredActiveTab = (): ExportTab => {
  try {
    const raw = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (raw === 'departments' || raw === 'assigned') return raw;
  } catch {
    // ignore
  }
  return 'departments';
};

const saveStoredActiveTab = (tab: ExportTab): void => {
  try {
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
  } catch {
    // ignore
  }
};

export const MassTimesheetExportPage: FC = () => {
  const now = useMemo(() => new Date(), []);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const monthRange = useMemo(() => getMonthRange(year, month), [year, month]);
  const [rangeStart, setRangeStart] = useState<string>(monthRange.first);
  const [rangeEnd, setRangeEnd] = useState<string>(monthRange.last);
  const [groupBy, setGroupBy] = useState<TimesheetGroupingMode>('employees');
  const [exportAs1C, setExportAs1C] = useState(false);
  const [activeTab, setActiveTab] = useState<ExportTab>(() => loadStoredActiveTab());

  useEffect(() => {
    // При смене месяца сбрасываем диапазон на полный месяц.
    setRangeStart(monthRange.first);
    setRangeEnd(monthRange.last);
  }, [monthRange.first, monthRange.last]);

  useEffect(() => {
    saveStoredActiveTab(activeTab);
  }, [activeTab]);

  const prevMonth = useCallback(() => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }, [month]);

  const nextMonth = useCallback(() => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }, [month]);

  const handleRangeStart = useCallback((value: string) => {
    if (!value) return;
    const clamped = value < monthRange.first ? monthRange.first : (value > monthRange.last ? monthRange.last : value);
    setRangeStart(clamped);
    if (rangeEnd < clamped) setRangeEnd(clamped);
  }, [monthRange.first, monthRange.last, rangeEnd]);

  const handleRangeEnd = useCallback((value: string) => {
    if (!value) return;
    const clamped = value < monthRange.first ? monthRange.first : (value > monthRange.last ? monthRange.last : value);
    setRangeEnd(clamped < rangeStart ? rangeStart : clamped);
  }, [monthRange.first, monthRange.last, rangeStart]);

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

      <section className="mte-range" aria-label="Период выгрузки табелей">
        <label className="mte-range-label">
          <span>С</span>
          <input
            type="date"
            className="mte-range-input"
            value={rangeStart}
            min={monthRange.first}
            max={monthRange.last}
            onChange={e => handleRangeStart(e.target.value)}
          />
        </label>
        <label className="mte-range-label">
          <span>по</span>
          <input
            type="date"
            className="mte-range-input"
            value={rangeEnd}
            min={rangeStart}
            max={monthRange.last}
            onChange={e => handleRangeEnd(e.target.value)}
          />
        </label>
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

      <div className="mte-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'departments'}
          className={`mte-tab-button ${activeTab === 'departments' ? 'mte-tab-button--active' : ''}`}
          onClick={() => setActiveTab('departments')}
        >
          По отделам
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'assigned'}
          className={`mte-tab-button ${activeTab === 'assigned' ? 'mte-tab-button--active' : ''}`}
          onClick={() => setActiveTab('assigned')}
        >
          Участки
        </button>
      </div>

      <div className="mte-body">
        {activeTab === 'departments' ? (
          <MassTimesheetExportDepartmentsTab
            year={year}
            month={month}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            groupBy={groupBy}
            exportAs1C={exportAs1C}
          />
        ) : (
          <MassTimesheetExportAssignedTab
            year={year}
            month={month}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            groupBy={groupBy}
            exportAs1C={exportAs1C}
          />
        )}
      </div>
    </div>
  );
};
