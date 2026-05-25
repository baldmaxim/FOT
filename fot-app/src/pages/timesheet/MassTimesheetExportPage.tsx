import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getMonthLabel } from '../../utils/calendarUtils';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';
import { useTimesheetMonthAccess } from '../../hooks/useTimesheetMonthAccess';
import {
  formatHalfLabel,
  getCurrentHalf,
  getHalfRange,
  type TimesheetHalf,
} from '../../utils/timesheetApprovalPeriod';
import { MassTimesheetExportDepartmentsTab } from './MassTimesheetExportDepartmentsTab';
import { MassTimesheetExportAssignedTab } from './MassTimesheetExportAssignedTab';
import './MassTimesheetExportPage.css';

type TimesheetGroupingMode = 'employees' | 'objects';
type ExportTab = 'departments' | 'assigned';

const ACTIVE_TAB_STORAGE_KEY = 'timesheet_export_active_tab_v2';

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

export const MassTimesheetExportPage: FC = () => {
  const now = useMemo(() => new Date(), []);
  const { isDepartmentScope } = useManagedDepartments();
  const monthAccess = useTimesheetMonthAccess({ enforceWhen: isDepartmentScope });
  const isRestrictedManagerView = monthAccess.isWindowEnforced;

  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [half, setHalf] = useState<TimesheetHalf>(() => {
    const current = getCurrentHalf(now);
    return (current.year === now.getFullYear() && current.month === now.getMonth() + 1) ? current.half : 'H1';
  });
  const halfRange = useMemo(() => getHalfRange(year, month, half), [year, month, half]);
  const rangeStart = halfRange.startDate;
  const rangeEnd = halfRange.endDate;
  const [groupBy, setGroupBy] = useState<TimesheetGroupingMode>('employees');
  const [exportAs1C, setExportAs1C] = useState(false);
  const [activeTab, setActiveTab] = useState<ExportTab>(() => loadStoredActiveTab());

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentMonthIndex = toMonthIndex(currentYear, currentMonth);
  const minAllowedMonthIndex = currentMonthIndex - monthAccess.monthsBack;
  const maxAllowedMonthIndex = currentMonthIndex + monthAccess.monthsForward;
  const selectedMonthIndex = toMonthIndex(year, month);

  const canGoPrev = !isRestrictedManagerView || selectedMonthIndex > minAllowedMonthIndex;
  const canGoNext = !isRestrictedManagerView || selectedMonthIndex < maxAllowedMonthIndex;

  useEffect(() => {
    if (!isRestrictedManagerView) return;
    if (selectedMonthIndex > maxAllowedMonthIndex) {
      const d = new Date(currentYear, currentMonth - 1 + monthAccess.monthsForward, 1);
      queueMicrotask(() => { setYear(d.getFullYear()); setMonth(d.getMonth() + 1); });
    } else if (selectedMonthIndex < minAllowedMonthIndex) {
      const d = new Date(currentYear, currentMonth - 1 - monthAccess.monthsBack, 1);
      queueMicrotask(() => { setYear(d.getFullYear()); setMonth(d.getMonth() + 1); });
    }
  }, [isRestrictedManagerView, selectedMonthIndex, minAllowedMonthIndex, maxAllowedMonthIndex, currentYear, currentMonth, monthAccess.monthsBack, monthAccess.monthsForward]);

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

  return (
    <div className="mte-page">
      <div className="mte-toolbar">
        <div className="mte-month-nav">
          <button className="mte-month-btn" onClick={prevMonth} disabled={!canGoPrev}>
            <ChevronLeft size={16} />
          </button>
          <span className="mte-month-label">{getMonthLabel(year, month)}</span>
          <button className="mte-month-btn" onClick={nextMonth} disabled={!canGoNext}>
            <ChevronRight size={16} />
          </button>
        </div>
        <section className="mte-half-toggle" aria-label="Период выгрузки табелей">
          <button
            type="button"
            className={`mte-half-chip ${half === 'H1' ? 'mte-half-chip--active' : ''}`}
            onClick={() => setHalf('H1')}
          >
            {formatHalfLabel(year, month, 'H1')}
          </button>
          <button
            type="button"
            className={`mte-half-chip ${half === 'H2' ? 'mte-half-chip--active' : ''}`}
            onClick={() => setHalf('H2')}
          >
            {formatHalfLabel(year, month, 'H2')}
          </button>
          <button
            type="button"
            className={`mte-half-chip ${half === 'FULL' ? 'mte-half-chip--active' : ''}`}
            onClick={() => setHalf('FULL')}
          >
            {formatHalfLabel(year, month, 'FULL')}
          </button>
        </section>
        <div className="mte-half-toggle" role="group" aria-label="Группировка">
          <button
            type="button"
            className={`mte-half-chip ${groupBy === 'employees' ? 'mte-half-chip--active' : ''}`}
            onClick={() => setGroupBy('employees')}
          >
            Сотрудники
          </button>
          <button
            type="button"
            className={`mte-half-chip ${groupBy === 'objects' ? 'mte-half-chip--active' : ''}`}
            onClick={() => setGroupBy('objects')}
          >
            Объекты
          </button>
        </div>
        <label className={`mte-inline-check mte-inline-check--push ${exportAs1C ? 'mte-inline-check--on' : ''}`}>
          <input
            type="checkbox"
            checked={exportAs1C}
            onChange={e => setExportAs1C(e.target.checked)}
          />
          <span className="mte-inline-check-box" aria-hidden="true" />
          <span className="mte-inline-check-label">Как в 1С</span>
        </label>
      </div>

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
