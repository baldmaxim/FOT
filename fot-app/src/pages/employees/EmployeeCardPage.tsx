import { Suspense, lazy, useState, useEffect, useCallback, useMemo, type FC } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams, useNavigationType } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Edit3, Archive, RotateCcw, Trash2,
  Briefcase, FolderOpen, CalendarDays, CheckCircle,
  Clock, DollarSign, BarChart3,
} from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import { useAuth } from '../../contexts/AuthContext';
import { useStructureTree } from '../../hooks/useStructure';
import { useEmployeeTimesheetMonth } from '../../hooks/useEmployeeTimesheet';
import {
  calculateAttendance, calculateAttendanceFromTimesheet, isEmployeeOnSite, computePeriodData,
} from '../../utils/attendanceCalc';
import type { EmployeeInput, SkudEvent } from '../../types';
import '../../styles/EmployeeCardPage.css';
import '../../styles/EmployeeCardV2.css';

const EmployeeAttendanceSection = lazy(() => import('../../components/employees/EmployeeAttendanceSection').then(module => ({
  default: module.EmployeeAttendanceSection,
})));
const EmployeeInfoSection = lazy(() => import('../../components/employees/EmployeeInfoSection').then(module => ({
  default: module.EmployeeInfoSection,
})));
const EmployeeHistorySection = lazy(() => import('../../components/employees/EmployeeHistorySection').then(module => ({
  default: module.EmployeeHistorySection,
})));
const EmployeeSkudControls = lazy(() => import('../../components/employees/EmployeeSkudControls').then(module => ({
  default: module.EmployeeSkudControls,
})));
const EmployeeSkudSection = lazy(() => import('../../components/employees/EmployeeSkudSection').then(module => ({
  default: module.EmployeeSkudSection,
})));

type Tab = 'attendance' | 'info' | 'history' | 'skud';
type SkudViewMode = 'day' | 'week' | 'month' | 'range';
const TABS: { key: Tab; label: string }[] = [
  { key: 'attendance', label: 'Посещаемость' },
  { key: 'info', label: 'Информация' },
  { key: 'history', label: 'История' },
  { key: 'skud', label: 'СКУД' },
];

const getInitials = (name: string) => {
  const parts = name.split(' ').filter(Boolean);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
};

const formatHireDate = (date: string) => {
  const d = new Date(date);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const MONTH_LABELS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const MONTH_NAMES_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const EMPTY_ATTENDANCE_STATS = {
  attendancePercent: 0,
  lateCount: 0,
  hoursWorked: 0,
  hoursPlanned: 0,
  avgArrivalTime: null,
  avgArrivalDiffMinutes: 0,
};

const EMPTY_WEEKLY_PATTERN = [
  { day: 'Пн', avgTime: null, heightPercent: 0 },
  { day: 'Вт', avgTime: null, heightPercent: 0 },
  { day: 'Ср', avgTime: null, heightPercent: 0 },
  { day: 'Чт', avgTime: null, heightPercent: 0 },
  { day: 'Пт', avgTime: null, heightPercent: 0 },
];

const toLocalISO = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseISO = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const navigateViewDate = (period: SkudViewMode, dateStr: string, dir: number): string => {
  const d = parseISO(dateStr);
  if (period === 'day') d.setDate(d.getDate() + dir);
  else if (period === 'week') d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir);
  return toLocalISO(d);
};

const getViewLabel = (period: SkudViewMode, dateStr: string): string => {
  const d = parseISO(dateStr);
  if (period === 'day') {
    return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  }
  if (period === 'week') {
    const start = new Date(d);
    const dow = start.getDay() || 7;
    start.setDate(start.getDate() - dow + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = (dt: Date) => dt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `${fmt(start)} — ${fmt(end)}`;
  }
  return `${MONTH_NAMES_NOM[d.getMonth()]} ${d.getFullYear()}`;
};

export const EmployeeCardPage: FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [searchParams] = useSearchParams();
  const locState = location.state as { label?: string; from?: string } | null;
  const savedBack = (() => {
    if (!id) return null;
    try { return JSON.parse(sessionStorage.getItem(`ec-back-${id}`) || 'null'); } catch { return null; }
  })() as { label?: string; from?: string } | null;
  const resolvedBackState = locState?.from
    ? locState
    : navigationType === 'POP'
      ? savedBack
      : null;
  const backLabel = resolvedBackState?.label || 'Сотрудники';
  const backPath = resolvedBackState?.from;

  useEffect(() => {
    if (!id) return;
    if (locState?.from) {
      sessionStorage.setItem(`ec-back-${id}`, JSON.stringify({ label: locState.label, from: locState.from }));
      return;
    }
    if (navigationType !== 'POP') {
      sessionStorage.removeItem(`ec-back-${id}`);
    }
  }, [id, locState?.from, locState?.label, navigationType]);

  const handleBack = () => {
    const historyIndex = typeof window !== 'undefined' ? window.history.state?.idx : undefined;
    if (typeof historyIndex === 'number' && historyIndex > 0) {
      navigate(-1);
      return;
    }
    if (backPath) {
      navigate(backPath, { replace: true });
      return;
    }
    navigate('/employees', { replace: true });
  };
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/employees') || canEditPage('/staff-control');

  // Deep-link: ?tab=skud&date=2026-03-18
  const urlTab = searchParams.get('tab') as Tab | null;
  const urlDate = searchParams.get('date');

  const queryClient = useQueryClient();
  const empIdNum = Number(id);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>(urlTab && ['attendance', 'info', 'history', 'skud'].includes(urlTab) ? urlTab : 'attendance');
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<EmployeeInput>>({});
  const [skudViewMode, setSkudViewMode] = useState<SkudViewMode>(urlDate ? 'day' : 'month');
  const [skudRangeStart, setSkudRangeStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [skudRangeEnd, setSkudRangeEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [skudViewDate, setSkudViewDate] = useState(() => urlDate || new Date().toISOString().slice(0, 10));
  const skudFocusDate = urlDate || null;
  const skudFocusKey = urlDate ? 1 : 0;

  // Calendar month — если есть urlDate, начинаем с его месяца
  const now = new Date();
  // Парсим urlDate напрямую (YYYY-MM-DD) без new Date() чтобы избежать сдвига часового пояса
  const urlYMD = urlDate ? urlDate.split('-').map(Number) : null;
  const [calMonth, setCalMonth] = useState(urlYMD ? urlYMD[1] - 1 : now.getMonth());
  const [calYear, setCalYear] = useState(urlYMD ? urlYMD[0] : now.getFullYear());

  const prevMonth = () => {
    if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); }
    else setCalMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); }
    else setCalMonth(m => m + 1);
  };

  // Карточка сотрудника — основные данные (серверный кэш TTL 60с + ETag)
  const employeeQuery = useQuery({
    queryKey: ['employee', empIdNum],
    queryFn: () => employeeService.getById(empIdNum),
    enabled: !!empIdNum && !Number.isNaN(empIdNum),
    staleTime: 60_000,
  });
  const employee = employeeQuery.data ?? null;
  const loading = employeeQuery.isLoading;

  // История сотрудника
  const historyQuery = useQuery({
    queryKey: ['employee-history', empIdNum],
    queryFn: () => employeeService.getHistory(empIdNum).catch(() => []),
    enabled: !!empIdNum && !Number.isNaN(empIdNum) && activeTab === 'history',
    staleTime: 60_000,
  });
  const history = historyQuery.data ?? [];

  // Структура (для редактирования отделов) — общий query key, но ленивый запуск только при редактировании
  useStructureTree(isEditing);

  // Настройки точек доступа (меняются редко, но нужны для расчёта внутренних проходов)
  const accessPointsQuery = useQuery({
    queryKey: ['skud-access-point-settings'],
    queryFn: () => skudService.getAccessPointSettings().catch(() => []),
    staleTime: 10 * 60_000,
  });
  const internalPoints = useMemo<Set<string>>(() => {
    const settings = accessPointsQuery.data ?? [];
    return new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name.trim()));
  }, [accessPointsQuery.data]);

  // СКУД события за выбранный месяц
  const monthRange = useMemo(() => {
    const startDate = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-01`;
    const endDate = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(new Date(calYear, calMonth + 1, 0).getDate()).padStart(2, '0')}`;
    return { startDate, endDate };
  }, [calMonth, calYear]);
  const monthKey = useMemo(
    () => `${calYear}-${String(calMonth + 1).padStart(2, '0')}`,
    [calMonth, calYear],
  );

  const canonicalTimesheetQuery = useEmployeeTimesheetMonth(
    !Number.isNaN(empIdNum) ? empIdNum : null,
    monthKey,
    !!empIdNum && !Number.isNaN(empIdNum),
  );
  const shouldLoadMonthlySkudFallback = canonicalTimesheetQuery.isError;

  const skudEventsQuery = useQuery({
    queryKey: ['skud-employee-events', empIdNum, monthRange.startDate, monthRange.endDate],
    queryFn: () => skudService.getEmployeeEvents(empIdNum, monthRange.startDate, monthRange.endDate).catch(() => [] as SkudEvent[]),
    enabled: !!empIdNum && !Number.isNaN(empIdNum) && shouldLoadMonthlySkudFallback,
    staleTime: 30_000,
  });
  const skudEvents = useMemo<SkudEvent[]>(() => skudEventsQuery.data ?? [], [skudEventsQuery.data]);

  // События сегодняшнего дня для статуса on-site.
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const todayEventsQuery = useQuery({
    queryKey: ['skud-employee-events-today', empIdNum, todayStr],
    queryFn: () => skudService.getEmployeeEvents(empIdNum, todayStr, todayStr).catch(() => [] as SkudEvent[]),
    enabled: !!empIdNum && !Number.isNaN(empIdNum),
    staleTime: 30_000,
  });
  const todayEventsFromMonth = useMemo(
    () => skudEvents.filter(e => e.event_date === todayStr),
    [skudEvents, todayStr],
  );
  const todayEvents = useMemo<SkudEvent[]>(() => {
    if (todayEventsQuery.data) {
      return [...todayEventsQuery.data].sort((a, b) => a.event_time.localeCompare(b.event_time));
    }
    return [...todayEventsFromMonth].sort((a, b) => a.event_time.localeCompare(b.event_time));
  }, [todayEventsQuery.data, todayEventsFromMonth]);

  const reloadSkudEvents = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['skud-employee-events', empIdNum] });
    queryClient.invalidateQueries({ queryKey: ['skud-employee-events-today', empIdNum] });
    queryClient.invalidateQueries({ queryKey: ['skud-employee-events-day', empIdNum] });
  }, [queryClient, empIdNum]);

  const reloadEmployee = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['employee', empIdNum] });
    queryClient.invalidateQueries({ queryKey: ['employee-history', empIdNum] });
    queryClient.invalidateQueries({ queryKey: ['employee-timesheet-summary', empIdNum] });
  }, [queryClient, empIdNum]);

  // Calculated attendance data
  const attendance = useMemo(() => {
    if (canonicalTimesheetQuery.isLoading && !canonicalTimesheetQuery.data) {
      return null;
    }

    const timesheetData = canonicalTimesheetQuery.data;
    if (timesheetData) {
      return calculateAttendanceFromTimesheet({
        employeeId: empIdNum,
        entries: timesheetData.entries,
        year: calYear,
        month: calMonth,
        schedules: timesheetData.schedules,
        dailySchedules: timesheetData.daily_schedules,
        calendar: timesheetData.calendar || null,
        liveDayEvents: todayEvents,
        internalPoints,
      });
    }

    if (canonicalTimesheetQuery.isError) {
      if (skudEventsQuery.isLoading && !skudEventsQuery.data) {
        return null;
      }
      return calculateAttendance(skudEvents, internalPoints, calYear, calMonth);
    }

    return calculateAttendance(skudEvents, internalPoints, calYear, calMonth);
  }, [
    canonicalTimesheetQuery.isLoading,
    canonicalTimesheetQuery.data,
    canonicalTimesheetQuery.isError,
    skudEventsQuery.isLoading,
    skudEventsQuery.data,
    empIdNum,
    calYear,
    calMonth,
    todayEvents,
    skudEvents,
    internalPoints,
  ]);
  const attendanceLoading = attendance === null;
  const onSite = useMemo(() => isEmployeeOnSite(todayEvents, internalPoints), [todayEvents, internalPoints]);

  // Period-filtered stats + weekly pattern
  const statsPeriod = 'month';
  const periodData = useMemo(() => {
    if (!attendance) {
      return { stats: EMPTY_ATTENDANCE_STATS, weeklyPattern: EMPTY_WEEKLY_PATTERN };
    }

    const { stats: mStats, weeklyPattern: mPattern } = attendance;
    if (statsPeriod === 'month') return { stats: mStats, weeklyPattern: mPattern };
    const n = new Date();
    if (n.getFullYear() !== calYear || n.getMonth() !== calMonth)
      return { stats: mStats, weeklyPattern: mPattern };
    const todayDate = n.getDate();
    const filteredDays = statsPeriod === 'today'
      ? attendance.days.filter(d => d.day === todayDate)
      : attendance.days.filter(d => d.day >= Math.max(1, todayDate - 6) && d.day <= todayDate);
    return computePeriodData(filteredDays, calYear, calMonth);
  }, [statsPeriod, attendance, calYear, calMonth]);

  // Calendar day click → attendance detail pane
  const [selectedCalDayState, setSelectedCalDay] = useState<string | null>(null);
  const selectedCalDay = useMemo(() => {
    if (!selectedCalDayState) return null;
    const [selectedYear, selectedMonth] = selectedCalDayState.split('-').map(Number);
    if (selectedYear !== calYear || selectedMonth !== calMonth + 1) return null;
    return selectedCalDayState;
  }, [selectedCalDayState, calYear, calMonth]);
  const selectedCalDayNumber = useMemo(() => {
    if (!selectedCalDay) return null;
    const [selectedYear, selectedMonth, selectedDay] = selectedCalDay.split('-').map(Number);
    if (selectedYear !== calYear || selectedMonth !== calMonth + 1) return null;
    return selectedDay;
  }, [selectedCalDay, calYear, calMonth]);

  const handleDayClick = useCallback((day: number) => {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    setSelectedCalDay(dateStr);
  }, [calYear, calMonth]);

  const selectedDayEvents = useMemo(() => {
    if (!selectedCalDay) return [];
    return skudEvents
      .filter(e => e.event_date === selectedCalDay)
      .sort((a, b) => a.event_time.localeCompare(b.event_time));
  }, [skudEvents, selectedCalDay]);
  const getDayEventsStaleTime = useCallback((dateStr: string) => (
    dateStr === todayStr ? 15_000 : 5 * 60_000
  ), [todayStr]);
  const fetchDayEvents = useCallback((dateStr: string) => (
    skudService.getEmployeeEvents(empIdNum, dateStr, dateStr).catch(() => [] as SkudEvent[])
  ), [empIdNum]);
  const selectedDayEventsQuery = useQuery({
    queryKey: ['skud-employee-events-day', empIdNum, selectedCalDay],
    queryFn: () => fetchDayEvents(selectedCalDay!),
    enabled: !!empIdNum && !Number.isNaN(empIdNum) && !!selectedCalDay && activeTab === 'attendance',
    staleTime: selectedCalDay ? getDayEventsStaleTime(selectedCalDay) : 30_000,
  });
  const prefetchDayEvents = useCallback((day: number) => {
    if (!empIdNum || Number.isNaN(empIdNum)) return;
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    void queryClient.prefetchQuery({
      queryKey: ['skud-employee-events-day', empIdNum, dateStr],
      queryFn: () => fetchDayEvents(dateStr),
      staleTime: getDayEventsStaleTime(dateStr),
    });
  }, [empIdNum, calYear, calMonth, queryClient, fetchDayEvents, getDayEventsStaleTime]);
  const selectedDayEventsFast = useMemo(() => {
    if (!selectedCalDay) return [];
    if (selectedDayEventsQuery.data) {
      return [...selectedDayEventsQuery.data].sort((a, b) => a.event_time.localeCompare(b.event_time));
    }
    if (selectedCalDay === todayStr && todayEvents.length > 0) {
      return [...todayEvents].sort((a, b) => a.event_time.localeCompare(b.event_time));
    }
    return selectedDayEvents;
  }, [selectedCalDay, selectedDayEventsQuery.data, selectedDayEvents, todayStr, todayEvents]);

  // Actions
  const startEditing = () => {
    if (!employee) return;
    const isSigurLinked = employee.sigur_employee_id != null;
    setEditData({
      full_name: employee.full_name,
      hire_date: employee.hire_date,
      ...(isSigurLinked ? {} : {
        birth_date: employee.birth_date || undefined,
        current_salary: employee.current_salary,
        org_department_id: employee.org_department_id || undefined,
      }),
    });
    setIsEditing(true);
    setActiveTab('info');
  };

  const saveEditing = async () => {
    if (!employee) return;
    try {
      const payload = employee.sigur_employee_id != null
        ? { full_name: editData.full_name || '' }
        : editData;
      await employeeService.update(employee.id, payload);
      setIsEditing(false);
      reloadEmployee();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  };

  const handleArchive = async () => {
    if (!employee || !confirm('Перевести сотрудника в архив?')) return;
    try { await employeeService.archive(employee.id); reloadEmployee(); }
    catch { setError('Ошибка архивации'); }
  };

  const handleRestore = async () => {
    if (!employee) return;
    try { await employeeService.restore(employee.id); reloadEmployee(); }
    catch { setError('Ошибка восстановления'); }
  };

  const handleDelete = async () => {
    if (!employee || !confirm('Удалить сотрудника? Это действие необратимо.')) return;
    try { await employeeService.delete(employee.id); handleBack(); }
    catch { setError('Ошибка удаления'); }
  };


  // Loading / Error states
  if (loading) return <div className="ec-content"><div className="ec-loading">Загрузка...</div></div>;
  if (error && !employee) {
    return (
      <div className="ec-content">
        <div className="ec-error">
          <p>{error}</p>
          <button className="btn-back-link" onClick={handleBack}>
            <ArrowLeft size={16} /> {backLabel}
          </button>
        </div>
      </div>
    );
  }
  if (!employee) return null;

  const { stats: pStats } = periodData;
  const attendanceViewModel = activeTab === 'attendance' ? (() => {
    const currentDate = new Date();
    const todayLocalStr = currentDate.toISOString().slice(0, 10);
    const showDate = selectedCalDay || todayLocalStr;
    const showEvents = selectedCalDay
      ? selectedDayEventsFast
      : todayEvents
        .filter(e => !e.access_point || !internalPoints.has(e.access_point))
        .sort((a, b) => a.event_time.localeCompare(b.event_time));
    const showEventsLoading = selectedCalDay
      ? selectedDayEventsQuery.isLoading && selectedDayEventsFast.length === 0
      : todayEventsQuery.isLoading && todayEvents.length === 0;
    const dayLabel = selectedCalDay
      ? new Date(`${selectedCalDay}T00:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
      : `Сегодня, ${currentDate.getDate()} ${MONTH_LABELS_GEN[currentDate.getMonth()]}`;

    return {
      showDate,
      showEvents,
      showEventsLoading,
      dayLabel,
    };
  })() : null;

  return (
    <div className="ec-content">
      {error && (
        <div className="ec-error-banner">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

      {/* ===== Profile Card ===== */}
      <div className="ec-profile-card">
        <button className="ec-back-btn" onClick={handleBack}>
          <ArrowLeft size={16} />
          {backLabel}
        </button>
        <div className="ec-profile">
          <div className="ec-avatar">
            {getInitials(employee.full_name)}
            <div className={`ec-avatar-status ${onSite ? 'online' : 'offline'}`} />
          </div>
          <div className="ec-profile-info">
            <h1 className="ec-profile-name">
              {employee.full_name}
              {employee.is_archived && <span className="ec-badge-archived">Архив</span>}
              {employee.employment_status === 'fired' && <span className="ec-badge-fired">Уволен</span>}
            </h1>
            <div className="ec-profile-badges">
              {employee.position_name && (
                <span className="ec-badge"><Briefcase size={14} />{employee.position_name}</span>
              )}
              {employee.department && (
                <span className="ec-badge accent"><FolderOpen size={14} />{employee.department}</span>
              )}
              {employee.employment_status === 'active' && !employee.is_archived && (
                <span className="ec-badge accent"><CheckCircle size={14} />Активен</span>
              )}
            </div>
            <div className="ec-profile-meta">
              <div className="ec-meta-item">
                <CalendarDays size={16} />
                В компании с {formatHireDate(employee.hire_date)}
              </div>
              {employee.email && (
                <div className="ec-meta-item">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                  {employee.email}
                </div>
              )}
              <span className="ec-profile-id">ID: {employee.id}</span>
            </div>
          </div>
          {canEdit && (
            <div className="ec-profile-actions">
              <button className="ec-action-btn" onClick={startEditing}>
                <Edit3 size={16} /> {employee.sigur_employee_id != null ? 'Изменить ФИО' : 'Редактировать'}
              </button>
              {employee.is_archived ? (
                <button className="ec-action-btn" onClick={handleRestore}>
                  <RotateCcw size={16} /> Восстановить
                </button>
              ) : (
                <button className="ec-action-btn" onClick={handleArchive}>
                  <Archive size={16} /> В архив
                </button>
              )}
              <button className="ec-action-btn danger" onClick={handleDelete}>
                <Trash2 size={16} /> Удалить
              </button>
            </div>
          )}
        </div>

        <div className="ec-stats-row">
          <div className="ec-stat-card">
            <div className="ec-stat-icon green"><CheckCircle size={12} /></div>
            <span className="ec-stat-label-inline">Посещаемость</span>
            <div className="ec-stat-value">{attendanceLoading ? '—' : `${pStats.attendancePercent}%`}</div>
          </div>
          <div className="ec-stat-card">
            <div className="ec-stat-icon orange"><Clock size={12} /></div>
            <span className="ec-stat-label-inline">Опозданий</span>
            <div className="ec-stat-value">{attendanceLoading ? '—' : pStats.lateCount}</div>
          </div>
          <div className="ec-stat-card">
            <div className="ec-stat-icon blue"><DollarSign size={12} /></div>
            <span className="ec-stat-label-inline">Часов</span>
            <div className="ec-stat-value">{attendanceLoading ? '—' : `${pStats.hoursWorked}/${pStats.hoursPlanned}`}</div>
          </div>
          <div className="ec-stat-card">
            <div className="ec-stat-icon purple"><BarChart3 size={12} /></div>
            <span className="ec-stat-label-inline">Приход</span>
            <div className="ec-stat-value">{attendanceLoading ? '—' : (pStats.avgArrivalTime || '—')}</div>
          </div>
        </div>
      </div>

      {/* ===== Period + Tabs ===== */}
      <div className="ec-controls-bar">
        <div className="ec-tabs">
          {TABS.map(t => (
            <button
              key={t.key}
              className={`ec-tab ${activeTab === t.key ? 'active' : ''}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {activeTab === 'skud' && (
          <Suspense fallback={<div className="ec-loading">Загрузка фильтров...</div>}>
            <EmployeeSkudControls
              viewMode={skudViewMode}
              onViewModeChange={(mode) => {
                setSkudViewMode(mode);
                if (mode !== 'range') {
                  setSkudViewDate(skudFocusDate || `${calYear}-${String(calMonth + 1).padStart(2, '0')}-01`);
                }
              }}
              rangeStart={skudRangeStart}
              rangeEnd={skudRangeEnd}
              onRangeStartChange={setSkudRangeStart}
              onRangeEndChange={setSkudRangeEnd}
              viewLabel={getViewLabel(skudViewMode, skudViewDate)}
              onPrev={() => setSkudViewDate(s => navigateViewDate(skudViewMode, s, -1))}
              onNext={() => setSkudViewDate(s => navigateViewDate(skudViewMode, s, 1))}
            />
          </Suspense>
        )}
      </div>


      {/* ===== Tab Content ===== */}
      {activeTab === 'attendance' && attendanceViewModel && (
        <Suspense fallback={<div className="ec-loading">Загрузка посещаемости...</div>}>
          <EmployeeAttendanceSection
            employee={employee}
            attendanceDays={attendance?.days ?? []}
            attendanceLoading={attendanceLoading}
            year={calYear}
            month={calMonth}
            onPrevMonth={prevMonth}
            onNextMonth={nextMonth}
            onDayClick={handleDayClick}
            onDayPrefetch={prefetchDayEvents}
            selectedDay={selectedCalDayNumber}
            dayLabel={attendanceViewModel.dayLabel}
            showDate={attendanceViewModel.showDate}
            showEvents={attendanceViewModel.showEvents}
            showEventsLoading={attendanceViewModel.showEventsLoading}
            weeklyPattern={periodData.weeklyPattern}
            alerts={attendance?.alerts ?? []}
          />
        </Suspense>
      )}

      {activeTab === 'info' && (
        <div className="ec-tab-content-full">
          <Suspense fallback={<div className="ec-loading">Загрузка раздела...</div>}>
            <EmployeeInfoSection
              employee={employee}
              isEditing={isEditing}
              isSigurLinked={employee.sigur_employee_id != null}
              editData={editData}
              onEditDataChange={setEditData}
              onSave={saveEditing}
              onCancel={() => { setIsEditing(false); setEditData({}); }}
            />
          </Suspense>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="ec-tab-content-full">
          <Suspense fallback={<div className="ec-loading">Загрузка истории...</div>}>
            <EmployeeHistorySection history={history} />
          </Suspense>
        </div>
      )}

      {activeTab === 'skud' && (
        <Suspense fallback={<div className="ec-loading">Загрузка СКУД...</div>}>
          <EmployeeSkudSection
            employeeId={employee.id}
            employeeName={employee.full_name}
            departmentId={employee.org_department_id || undefined}
            onSync={reloadSkudEvents}
            focusDate={skudFocusDate}
            focusKey={skudFocusKey}
            externalViewMode={skudViewMode}
            externalRangeStart={skudRangeStart}
            externalRangeEnd={skudRangeEnd}
            externalViewDate={skudViewDate}
          />
        </Suspense>
      )}

    </div>
  );
};
