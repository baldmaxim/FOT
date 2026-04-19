import { type FC, useState, useMemo, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getMonthLabel } from '../../utils/calendarUtils';
import { formatTimesheetHalfLabel, type TimesheetApprovalHalf } from '../../utils/timesheetApprovalPeriod';
import { MassTimesheetExportDepartmentsTab } from './MassTimesheetExportDepartmentsTab';
import { MassTimesheetExportAssignedTab } from './MassTimesheetExportAssignedTab';
import './MassTimesheetExportPage.css';

type TimesheetDisplaySegment = TimesheetApprovalHalf | 'FULL';
type TimesheetGroupingMode = 'employees' | 'objects';
type ExportTab = 'departments' | 'assigned';

const ACTIVE_TAB_STORAGE_KEY = 'timesheet_export_active_tab_v1';

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
  const [segmentOverride, setSegmentOverride] = useState<TimesheetDisplaySegment | null>(null);
  const [groupBy, setGroupBy] = useState<TimesheetGroupingMode>('employees');
  const [exportAs1C, setExportAs1C] = useState(false);
  const [activeTab, setActiveTab] = useState<ExportTab>(() => loadStoredActiveTab());

  const activeSegment = useMemo<TimesheetDisplaySegment>(
    () => segmentOverride ?? resolveDefaultSegment(year, month, now),
    [segmentOverride, year, month, now],
  );

  useEffect(() => {
    setSegmentOverride(null);
  }, [year, month]);

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

  const handleSegmentChange = useCallback((segment: TimesheetDisplaySegment) => {
    setSegmentOverride(segment);
  }, []);

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
          Назначенные
        </button>
      </div>

      <div className="mte-body">
        {activeTab === 'departments' ? (
          <MassTimesheetExportDepartmentsTab
            year={year}
            month={month}
            activeSegment={activeSegment}
            groupBy={groupBy}
            exportAs1C={exportAs1C}
          />
        ) : (
          <MassTimesheetExportAssignedTab
            year={year}
            month={month}
            activeSegment={activeSegment}
            groupBy={groupBy}
            exportAs1C={exportAs1C}
          />
        )}
      </div>
    </div>
  );
};
