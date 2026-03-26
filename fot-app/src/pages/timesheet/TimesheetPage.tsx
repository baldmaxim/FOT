import { type FC, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, Download } from 'lucide-react';
import { TimesheetStats } from '../../components/timesheet/TimesheetStats';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { TimesheetSidePanel } from '../../components/timesheet/TimesheetSidePanel';
import { TimesheetCorrectionModal } from '../../components/timesheet/TimesheetCorrectionModal';
import { timesheetService } from '../../services/timesheetService';
import { apiClient } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { getMonthLabel, formatDateRu } from '../../utils/calendarUtils';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetStats as ITimesheetStats,
  TimesheetStatus,
} from '../../types';
import { TimesheetApprovalBar } from '../../components/timesheet/TimesheetApprovalBar';
import './TimesheetPage.css';

interface IDeptOption {
  id: string;
  name: string;
}

interface IDbDepartment {
  id: string;
  name: string;
  children: IDbDepartment[];
}

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

const DEFAULT_STATS: ITimesheetStats = {
  employeeCount: 0,
  workingDays: 0,
  normHours: 0,
  actualHours: 0,
  deviations: { late: 0, absent: 0, sick: 0 },
};

export const TimesheetPage: FC = () => {
  const { positionType, profile } = useAuth();
  const isHeaderOnly = positionType === 'header';
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [employees, setEmployees] = useState<TimesheetEmployee[]>([]);
  const [entries, setEntries] = useState<TimesheetEntry[]>([]);
  const [stats, setStats] = useState<ITimesheetStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(false);

  // Department selector
  const [deptOptions, setDeptOptions] = useState<IDeptOption[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [deptOpen, setDeptOpen] = useState(false);
  const [deptSearch, setDeptSearch] = useState('');
  const deptRef = useRef<HTMLDivElement>(null);

  // Side panel
  const [panelEmployee, setPanelEmployee] = useState<TimesheetEmployee | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);

  // Load departments
  useEffect(() => {
    apiClient.get<{ success: boolean; data: { departments: IDbDepartment[] } }>('/structure')
      .then(res => {
        const deps = res.data?.departments || [];
        const flat = flattenTree(deps);
        setDeptOptions(flat);

        // Для header: автоматически выбрать свой отдел
        if (isHeaderOnly && profile?.department_id && !selectedDeptId) {
          setSelectedDeptId(profile.department_id);
        }
      })
      .catch(() => {});
  }, [isHeaderOnly, profile?.department_id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Load timesheet data
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const res = await timesheetService.getAll({
        month: monthStr,
        department_id: selectedDeptId || undefined,
      });
      setEmployees(res.employees || []);
      setEntries(res.entries || []);
      setStats(res.stats || DEFAULT_STATS);
    } catch {
      setEmployees([]);
      setEntries([]);
      setStats(DEFAULT_STATS);
    } finally {
      setLoading(false);
    }
  }, [year, month, selectedDeptId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
  const handleSaveCorrection = async (status: TimesheetStatus, hours: number | null, notes: string) => {
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
      await loadData();
    } catch (err) {
      console.error('Save correction error:', err);
    }
  };

  // Export
  const handleExport = async () => {
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.export({
        month: monthStr,
        department_id: selectedDeptId || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `timesheet-${monthStr}.xlsx`;
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

  const selectedDeptName = selectedDeptId
    ? deptOptions.find(d => d.id === selectedDeptId)?.name || 'Отдел'
    : 'Все отделы';

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
            {isHeaderOnly ? (
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
            departmentId={selectedDeptId}
            period={`${year}-${String(month).padStart(2, '0')}`}
          />
          <button className="ts-btn" onClick={handleExport}>
            <Download size={16} />
            Экспорт
          </button>
        </div>
      </div>

      {/* Stats */}
      <TimesheetStats stats={stats} />

      {/* Grid */}
      {loading ? (
        <div className="ts-table-container">
          <div className="ts-loading">Загрузка табеля...</div>
        </div>
      ) : !selectedDeptId ? (
        <div className="ts-table-container">
          <div className="ts-loading">Выберите отдел для отображения табеля</div>
        </div>
      ) : (
        <TimesheetGrid
          employees={employees}
          entries={entries}
          year={year}
          month={month}
          onEmployeeClick={handleEmployeeClick}
          onDayClick={handleDayClick}
        />
      )}

      {/* Side Panel */}
      <TimesheetSidePanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        employee={panelEmployee}
        entries={panelEntries}
        year={year}
        month={month}
      />

      {/* Correction Modal */}
      <TimesheetCorrectionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleSaveCorrection}
        initialStatus={modalEntry?.status || 'work'}
        initialHours={modalEntry?.hours_worked}
        dayLabel={`${formatDateRu(modalDay, month)}`}
        employeeId={modalEmployee?.id}
        workDate={`${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`}
      />
    </div>
  );
};
