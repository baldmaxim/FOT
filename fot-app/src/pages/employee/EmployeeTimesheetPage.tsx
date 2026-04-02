import { type FC, useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { TimesheetStats } from '../../components/timesheet/TimesheetStats';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { TimesheetSidePanel } from '../../components/timesheet/TimesheetSidePanel';
import { TimesheetCorrectionModal } from '../../components/timesheet/TimesheetCorrectionModal';
import { timesheetService } from '../../services/timesheetService';
import { useAuth } from '../../contexts/AuthContext';
import { getMonthLabel, formatDateRu } from '../../utils/calendarUtils';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetStats as ITimesheetStats,
  TimesheetStatus,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import '../../pages/timesheet/TimesheetPage.css';

const DEFAULT_STATS: ITimesheetStats = {
  employeeCount: 0,
  workingDays: 0,
  normHours: 0,
  actualHours: 0,
  deviations: { late: 0, absent: 0, sick: 0 },
};

export const EmployeeTimesheetPage: FC = () => {
  const { profile } = useAuth();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [allEmployees, setAllEmployees] = useState<TimesheetEmployee[]>([]);
  const [allEntries, setAllEntries] = useState<TimesheetEntry[]>([]);
  const [stats, setStats] = useState<ITimesheetStats>(DEFAULT_STATS);
  const [schedules, setSchedules] = useState<Record<number, IResolvedSchedule>>({});
  const [loading, setLoading] = useState(false);

  // Side panel
  const [panelEmployee, setPanelEmployee] = useState<TimesheetEmployee | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);

  const employeeId = profile?.employee_id;
  const departmentId = profile?.department_id;

  const loadData = useCallback(async () => {
    if (!departmentId) return;
    setLoading(true);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const res = await timesheetService.getAll({
        month: monthStr,
        department_id: departmentId,
      });
      setAllEmployees(res.employees || []);
      setAllEntries(res.entries || []);
      setStats(res.stats || DEFAULT_STATS);
      setSchedules(res.schedules || {});
    } catch {
      setAllEmployees([]);
      setAllEntries([]);
      setStats(DEFAULT_STATS);
    } finally {
      setLoading(false);
    }
  }, [year, month, departmentId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Filter to current employee only
  const employees = useMemo(() => {
    if (!employeeId) return [];
    return allEmployees.filter(e => e.id === employeeId);
  }, [allEmployees, employeeId]);

  const entries = useMemo(() => {
    if (!employeeId) return [];
    return allEntries.filter(e => e.employee_id === employeeId);
  }, [allEntries, employeeId]);

  // Recalculate stats for single employee
  const myStats = useMemo((): ITimesheetStats => {
    if (employees.length === 0) return DEFAULT_STATS;
    const workEntries = entries.filter(e => e.status === 'work');
    const actualHours = entries.reduce((s, e) => s + (e.hours_worked || 0), 0);
    return {
      employeeCount: 1,
      workingDays: stats.workingDays,
      normHours: stats.normHours / Math.max(stats.employeeCount, 1),
      actualHours: Math.round(actualHours * 100) / 100,
      deviations: {
        late: entries.filter(e => {
          if (e.status !== 'work' || !e.first_entry) return false;
          const empSched = schedules[employees[0]?.id];
          const threshold = empSched?.start_time || '09:00:00';
          return e.first_entry > threshold;
        }).length,
        absent: entries.filter(e => e.status === 'absent').length,
        sick: entries.filter(e => e.status === 'sick').length,
      },
    };
  }, [employees, entries, stats, schedules]);

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  const handleEmployeeClick = (emp: TimesheetEmployee) => {
    setPanelEmployee(emp);
    setPanelOpen(true);
  };

  const handleDayClick = (emp: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => {
    setModalEmployee(emp);
    setModalDay(day);
    setModalEntry(entry);
    setModalOpen(true);
  };

  const panelEntries = useMemo(() => {
    if (!panelEmployee) return [];
    return entries.filter(e => e.employee_id === panelEmployee.id);
  }, [panelEmployee, entries]);

  return (
    <div className="ts-page">
      <div className="ts-header">
        <div className="ts-header-left">
          <h1 className="ts-title">Мой табель</h1>
          <div className="ts-month-nav">
            <button className="ts-month-btn" onClick={prevMonth}>
              <ChevronLeft size={16} />
            </button>
            <span className="ts-month-label">{getMonthLabel(year, month)}</span>
            <button className="ts-month-btn" onClick={nextMonth}>
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      <TimesheetStats stats={myStats} />

      {loading ? (
        <div className="ts-table-container">
          <div className="ts-loading">Загрузка табеля...</div>
        </div>
      ) : employees.length === 0 ? (
        <div className="ts-table-container">
          <div className="ts-loading">Нет данных за выбранный период</div>
        </div>
      ) : (
        <TimesheetGrid
          employees={employees}
          entries={entries}
          year={year}
          month={month}
          schedules={schedules}
          onEmployeeClick={handleEmployeeClick}
          onDayClick={handleDayClick}
        />
      )}

      <TimesheetSidePanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        employee={panelEmployee}
        entries={panelEntries}
        year={year}
        month={month}
      />

      <TimesheetCorrectionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={async () => { setModalOpen(false); }}
        initialStatus={modalEntry?.status || 'work'}
        initialHours={modalEntry?.hours_worked}
        dayLabel={`${formatDateRu(modalDay, month)}`}
        employeeName={modalEmployee?.full_name}
        employeeId={modalEmployee?.id}
        workDate={`${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`}
        hideCorrectionTab
      />
    </div>
  );
};
