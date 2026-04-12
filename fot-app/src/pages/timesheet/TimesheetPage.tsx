import { type FC, Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ChevronDown, Download } from 'lucide-react';
import { TimesheetStats } from '../../components/timesheet/TimesheetStats';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { timesheetService } from '../../services/timesheetService';
import { useAuth } from '../../contexts/AuthContext';
import { useStructureTree } from '../../hooks/useStructure';
import { getMonthLabel, formatDateRu } from '../../utils/calendarUtils';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetStats as ITimesheetStats,
  TimesheetStatus,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import { TimesheetApprovalBar } from '../../components/timesheet/TimesheetApprovalBar';
import { getScheduleForTimesheetDay, getWorkHoursForDay } from '../../utils/scheduleUtils';
import './TimesheetPage.css';

const TimesheetSidePanel = lazy(() => import('../../components/timesheet/TimesheetSidePanel').then(module => ({
  default: module.TimesheetSidePanel,
})));
const TimesheetCorrectionModal = lazy(() => import('../../components/timesheet/TimesheetCorrectionModal').then(module => ({
  default: module.TimesheetCorrectionModal,
})));
const LateRatingModal = lazy(() => import('../../components/timesheet/LateRatingModal').then(module => ({
  default: module.LateRatingModal,
})));

interface IDeptOption {
  id: string;
  name: string;
}

interface IDbDepartment {
  id: string;
  name: string;
  children: IDbDepartment[];
}

const DEPARTMENT_TYPE_PRIORITY = ['ТО', 'ОСП'] as const;
const departmentNameCollator = new Intl.Collator('ru', {
  sensitivity: 'base',
  ignorePunctuation: true,
  numeric: true,
});

const flattenTree = (nodes: IDbDepartment[]): IDeptOption[] => {
  const result: IDeptOption[] = [];
  for (const node of nodes) {
    result.push({ id: node.id, name: node.name });
    if (node.children && node.children.length > 0) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
};

const getDepartmentType = (name: string): string | null => {
  const match = name.trim().match(/\(([^()]+)\)\s*$/u);
  return match ? match[1].trim().toUpperCase() : null;
};

const getDepartmentBaseName = (name: string): string => (
  name.replace(/\s*\([^()]+\)\s*$/u, '').trim()
);

const getDepartmentPriority = (type: string | null): number => {
  if (!type) return DEPARTMENT_TYPE_PRIORITY.length + 1;
  const index = DEPARTMENT_TYPE_PRIORITY.findIndex(marker => marker === type);
  return index === -1 ? DEPARTMENT_TYPE_PRIORITY.length : index;
};

const sortDepartments = (departments: IDeptOption[]): IDeptOption[] => (
  [...departments].sort((a, b) => {
    const aType = getDepartmentType(a.name);
    const bType = getDepartmentType(b.name);

    const priorityDiff = getDepartmentPriority(aType) - getDepartmentPriority(bType);
    if (priorityDiff !== 0) return priorityDiff;

    if (aType && bType) {
      const typeDiff = departmentNameCollator.compare(aType, bType);
      if (typeDiff !== 0) return typeDiff;
    }

    const baseNameDiff = departmentNameCollator.compare(
      getDepartmentBaseName(a.name),
      getDepartmentBaseName(b.name),
    );
    if (baseNameDiff !== 0) return baseNameDiff;

    const nameDiff = departmentNameCollator.compare(a.name.trim(), b.name.trim());
    if (nameDiff !== 0) return nameDiff;

    return a.id.localeCompare(b.id, 'ru');
  })
);

const DEFAULT_STATS: ITimesheetStats = {
  employeeCount: 0,
  workingDays: 0,
  normHours: 0,
  actualHours: 0,
  deviations: { late: 0, absent: 0, sick: 0 },
};
const EMPTY_SCHEDULES: Record<number, IResolvedSchedule> = {};
const EMPTY_DAILY_SCHEDULES: Record<number, Record<string, IResolvedSchedule>> = {};

export const TimesheetPage: FC = () => {
  const { hasPermission, profile } = useAuth();
  const queryClient = useQueryClient();
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  // Mobile compact mode
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Schedule settings panel

  // Department selector
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [deptOpen, setDeptOpen] = useState(false);
  const [deptSearch, setDeptSearch] = useState('');
  const deptRef = useRef<HTMLDivElement>(null);

  // Side panel
  const [panelEmployee, setPanelEmployee] = useState<TimesheetEmployee | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Late rating modal
  const [lateModalOpen, setLateModalOpen] = useState(false);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);

  const structureQuery = useStructureTree();
  const deptOptions = useMemo(
    () => sortDepartments(flattenTree(structureQuery.data?.departments ?? [])),
    [structureQuery.data],
  );
  const effectiveSelectedDeptId = isDepartmentScope
    ? (selectedDeptId || profile?.department_id || null)
    : selectedDeptId;

  // Close dept dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (deptRef.current && !deptRef.current.contains(e.target as Node)) {
        setDeptOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const monthStr = useMemo(() => `${year}-${String(month).padStart(2, '0')}`, [year, month]);
  const timesheetQuery = useQuery({
    queryKey: ['timesheet-page', monthStr, effectiveSelectedDeptId ?? 'none'],
    queryFn: () => timesheetService.getAll({
      month: monthStr,
      department_id: effectiveSelectedDeptId || undefined,
    }),
    enabled: Boolean(effectiveSelectedDeptId),
    staleTime: 30_000,
    placeholderData: previousData => previousData,
  });
  const employees = useMemo<TimesheetEmployee[]>(
    () => timesheetQuery.data?.employees || [],
    [timesheetQuery.data],
  );
  const entries = useMemo<TimesheetEntry[]>(
    () => timesheetQuery.data?.entries || [],
    [timesheetQuery.data],
  );
  const stats = timesheetQuery.data?.stats || DEFAULT_STATS;
  const schedules = timesheetQuery.data?.schedules || EMPTY_SCHEDULES;
  const dailySchedules = timesheetQuery.data?.daily_schedules || EMPTY_DAILY_SCHEDULES;
  const calendar = timesheetQuery.data?.calendar || null;
  const loading = Boolean(effectiveSelectedDeptId) && timesheetQuery.isLoading;

  // Month navigation
  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  // Employee click -> side panel
  const handleEmployeeClick = (emp: TimesheetEmployee) => {
    setPanelEmployee(emp);
    setPanelOpen(true);
  };

  // Day click -> modal
  const handleDayClick = (emp: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => {
    setModalEmployee(emp);
    setModalDay(day);
    setModalEntry(entry);
    setModalOpen(true);
  };

  // Save correction
  const handleSaveCorrection = useCallback(async (status: TimesheetStatus, hours: number | null, notes: string) => {
    if (!modalEmployee) return;
    try {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
      if (modalEntry?.id) {
        await timesheetService.update(modalEntry.id, { status, hours_worked: hours, notes });
      } else {
        await timesheetService.create({
          employee_id: modalEmployee.id,
          work_date: workDate,
          status,
          hours_worked: hours,
          notes,
        });
      }
      setModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, effectiveSelectedDeptId ?? 'none'] });
    } catch (err) {
      console.error('Save correction error:', err);
    }
  }, [modalEmployee, year, month, modalDay, modalEntry, queryClient, monthStr, effectiveSelectedDeptId]);

  // Export
  const handleExport = async () => {
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.export({
        month: monthStr,
        department_id: effectiveSelectedDeptId || undefined,
      });
      const monthNames = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
        'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
      const filename = `${selectedDeptName}_${monthNames[month]}_${year}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
    }
  };

  // Panel entries for selected employee
  const panelEntries = useMemo(() => {
    if (!panelEmployee) return [];
    return entries.filter(e => e.employee_id === panelEmployee.id);
  }, [panelEmployee, entries]);

  // Filtered dept options
  const filteredDepts = useMemo(() => {
    if (!deptSearch) return deptOptions;
    const q = deptSearch.toLowerCase();
    return deptOptions.filter(d => d.name.toLowerCase().includes(q));
  }, [deptOptions, deptSearch]);

  const selectedDeptName = effectiveSelectedDeptId
    ? deptOptions.find(d => d.id === effectiveSelectedDeptId)?.name || 'Отдел'
    : 'Все отделы';

  const modalDefaultHours = useMemo(() => {
    if (modalEntry?.hours_worked != null) return modalEntry.hours_worked;
    if (!modalEmployee) return 8;
    const sched = getScheduleForTimesheetDay(schedules, dailySchedules, modalEmployee.id, year, month, modalDay);
    return getWorkHoursForDay(sched, year, month, modalDay);
  }, [modalEntry, modalEmployee, schedules, dailySchedules, year, month, modalDay]);

  return (
    <div className="ts-page">
      {/* Header */}
      <div className="ts-header">
        <div className="ts-header-left">
          <h1 className="ts-title">Табель</h1>
          <div className="ts-month-nav">
            <button className="ts-month-btn" onClick={prevMonth}>
              <ChevronLeft size={16} />
            </button>
            <span className="ts-month-label">{getMonthLabel(year, month)}</span>
            <button className="ts-month-btn" onClick={nextMonth}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="ts-dept-wrap" ref={deptRef}>
            {isDepartmentScope ? (
              <button className="ts-dept-btn" style={{ cursor: 'default', opacity: 0.8 }}>
                {selectedDeptName}
              </button>
            ) : (
              <>
                <button className="ts-dept-btn" onClick={() => setDeptOpen(!deptOpen)}>
                  {selectedDeptName}
                  <ChevronDown size={16} />
                </button>
                {deptOpen && (
                  <div className="ts-dept-dropdown">
                    <input
                      className="ts-dept-search"
                      placeholder="Поиск отдела..."
                      value={deptSearch}
                      onChange={e => setDeptSearch(e.target.value)}
                      autoFocus
                    />
                    <div
                      className={`ts-dept-item ${!selectedDeptId ? 'ts-dept-item--active' : ''}`}
                      onClick={() => { setSelectedDeptId(null); setDeptOpen(false); }}
                    >
                      Все отделы
                    </div>
                    {filteredDepts.map(d => (
                      <div
                        key={d.id}
                        className={`ts-dept-item ${selectedDeptId === d.id ? 'ts-dept-item--active' : ''}`}
                        onClick={() => { setSelectedDeptId(d.id); setDeptOpen(false); }}
                      >
                        {d.name}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="ts-header-right">
          <TimesheetApprovalBar
            departmentId={effectiveSelectedDeptId}
            period={`${year}-${String(month).padStart(2, '0')}`}
          />
          <button className="ts-btn" onClick={handleExport}>
            <Download size={16} />
            Экспорт
          </button>
        </div>
      </div>

      {/* Stats */}
      <TimesheetStats stats={stats} onLateClick={() => setLateModalOpen(true)} />

      {/* Grid */}
      {loading ? (
        <div className="ts-table-container">
          <div className="ts-loading">Загрузка табеля...</div>
        </div>
      ) : !effectiveSelectedDeptId ? (
        <div className="ts-table-container">
          <div className="ts-loading">Выберите отдел для отображения табеля</div>
        </div>
      ) : (
        <TimesheetGrid
          employees={employees}
          entries={entries}
          year={year}
          month={month}
          schedules={schedules}
          dailySchedules={dailySchedules}
          calendar={calendar}
          compact={isMobile}
          onEmployeeClick={handleEmployeeClick}
          onDayClick={handleDayClick}
        />
      )}

      {/* Side Panel */}
      {panelOpen && (
        <Suspense fallback={null}>
          <TimesheetSidePanel
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            employee={panelEmployee}
            entries={panelEntries}
            year={year}
            month={month}
            schedules={schedules}
            dailySchedules={dailySchedules}
            calendar={calendar}
          />
        </Suspense>
      )}

      {/* Late Rating Modal */}
      {lateModalOpen && (
        <Suspense fallback={null}>
          <LateRatingModal
            open={lateModalOpen}
            onClose={() => setLateModalOpen(false)}
            employees={employees}
            entries={entries}
            schedules={schedules}
            dailySchedules={dailySchedules}
          />
        </Suspense>
      )}

      {/* Correction Modal */}
      {modalOpen && (
        <Suspense fallback={null}>
          <TimesheetCorrectionModal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            onSave={handleSaveCorrection}
            initialStatus={modalEntry?.status || 'work'}
            initialHours={modalDefaultHours}
            dayLabel={`${formatDateRu(modalDay, month)}`}
            employeeName={modalEmployee?.full_name}
            employeeId={modalEmployee?.id}
            workDate={`${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`}
            correctionInfo={modalEntry?.is_correction ? {
              is_correction: true,
              corrected_at: modalEntry.corrected_at,
              corrected_by_name: modalEntry.corrected_by_name,
            } : null}
          />
        </Suspense>
      )}
    </div>
  );
};
