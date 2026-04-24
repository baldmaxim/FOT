import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getMonthLabel } from '../../utils/calendarUtils';
import { useAuth } from '../../contexts/AuthContext';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';
import { getTimesheetMonthAccess } from '../../utils/timesheetMonthAccess';
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

const toMonthIndex = (year: number, month: number): number => year * 12 + month - 1;

const parseMonth = (iso: string): { year: number; month: number } | null => {
  const match = /^(\d{4})-(\d{2})/.exec(iso);
  if (!match) return null;
  const y = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return { year: y, month: m };
};

export const MassTimesheetExportPage: FC = () => {
  const now = useMemo(() => new Date(), []);
  const { hasPermission, profile } = useAuth();
  const { isDepartmentScope } = useManagedDepartments();
  const isSuperAdmin = profile?.position_type === 'super_admin';
  const canManageAllDepartments = isSuperAdmin || hasPermission('data.scope.all');
  const isRestrictedManagerView = !canManageAllDepartments && isDepartmentScope;
  const monthAccess = useMemo(
    () => getTimesheetMonthAccess(isRestrictedManagerView, now),
    [isRestrictedManagerView, now],
  );

  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const monthRange = useMemo(() => getMonthRange(year, month), [year, month]);
  const [rangeStart, setRangeStart] = useState<string>(monthRange.first);
  const [rangeEnd, setRangeEnd] = useState<string>(monthRange.last);
  const [groupBy, setGroupBy] = useState<TimesheetGroupingMode>('employees');
  const [exportAs1C, setExportAs1C] = useState(false);
  const [activeTab, setActiveTab] = useState<ExportTab>(() => loadStoredActiveTab());

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentMonthIndex = toMonthIndex(currentYear, currentMonth);
  const previousMonthIndex = currentMonthIndex - 1;
  const selectedMonthIndex = toMonthIndex(year, month);

  const canGoPrev = !isRestrictedManagerView || selectedMonthIndex > previousMonthIndex;
  const canGoNext = !isRestrictedManagerView || selectedMonthIndex < currentMonthIndex;

  useEffect(() => {
    if (!isRestrictedManagerView) return;
    if (selectedMonthIndex > currentMonthIndex) {
      setYear(currentYear); setMonth(currentMonth);
    } else if (selectedMonthIndex < previousMonthIndex) {
      const d = new Date(currentYear, currentMonth - 2, 1);
      setYear(d.getFullYear()); setMonth(d.getMonth() + 1);
    }
  }, [isRestrictedManagerView, selectedMonthIndex, currentMonthIndex, previousMonthIndex, currentYear, currentMonth]);

  useEffect(() => {
    // При смене месяца сбрасываем диапазон на полный месяц.
    setRangeStart(monthRange.first);
    setRangeEnd(monthRange.last);
  }, [monthRange.first, monthRange.last]);

  useEffect(() => {
    saveStoredActiveTab(activeTab);
  }, [activeTab]);

  const prevMonth = useCallback(() => {
    if (!canGoPrev) return;
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }, [canGoPrev, month]);

  const nextMonth = useCallback(() => {
    if (!canGoNext) return;
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }, [canGoNext, month]);

  const applyDate = useCallback((value: string, kind: 'start' | 'end') => {
    const parsed = parseMonth(value);
    if (!parsed) return;
    const jumpsMonth = parsed.year !== year || parsed.month !== month;
    const jumpAllowed = jumpsMonth && monthAccess.isMonthAllowed(parsed.year, parsed.month);
    if (jumpAllowed) {
      const nextRange = getMonthRange(parsed.year, parsed.month);
      setYear(parsed.year);
      setMonth(parsed.month);
      if (kind === 'start') {
        setRangeStart(value);
        setRangeEnd(nextRange.last);
      } else {
        setRangeStart(nextRange.first);
        setRangeEnd(value);
      }
      return;
    }
    const bounds = getMonthRange(year, month);
    const clamped = value < bounds.first ? bounds.first : (value > bounds.last ? bounds.last : value);
    if (kind === 'start') {
      setRangeStart(clamped);
      if (rangeEnd < clamped) setRangeEnd(clamped);
    } else {
      setRangeEnd(clamped < rangeStart ? rangeStart : clamped);
    }
  }, [year, month, monthAccess, rangeStart, rangeEnd]);

  const handleRangeStart = useCallback((value: string) => {
    if (!value) return;
    applyDate(value, 'start');
  }, [applyDate]);

  const handleRangeEnd = useCallback((value: string) => {
    if (!value) return;
    applyDate(value, 'end');
  }, [applyDate]);

  return (
    <div className="mte-page">
      <div className="mte-header">
        <h2 className="mte-title">Массовый экспорт</h2>
        <div className="mte-month-nav">
          <button className="mte-month-btn" onClick={prevMonth} disabled={!canGoPrev}>
            <ChevronLeft size={16} />
          </button>
          <span className="mte-month-label">{getMonthLabel(year, month)}</span>
          <button className="mte-month-btn" onClick={nextMonth} disabled={!canGoNext}>
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
            min={monthAccess.minDate}
            max={monthAccess.maxDate}
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
            max={monthAccess.maxDate}
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
