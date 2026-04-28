import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getMonthLabel } from '../../utils/calendarUtils';
import { useAuth } from '../../contexts/AuthContext';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';
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

const ACTIVE_TAB_STORAGE_KEY = 'timesheet_export_active_tab_v1';

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
  const { hasPermission, profile } = useAuth();
  const { isDepartmentScope } = useManagedDepartments();
  const isSuperAdmin = profile?.position_type === 'super_admin';
  const canManageAllDepartments = isSuperAdmin || hasPermission('data.scope.all');
  const isRestrictedManagerView = !canManageAllDepartments && isDepartmentScope;

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
