import { Suspense, lazy, useState, useEffect, useCallback, useMemo, type FC } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams, useNavigationType } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Edit3,
  Briefcase, FolderOpen, CalendarDays, CheckCircle,
  Clock, DollarSign, BarChart3, ShieldCheck, CalendarX,
} from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import { useAuth } from '../../contexts/AuthContext';
import { useInvalidateEmployeeData } from '../../hooks/useInvalidateEmployeeData';
import { useStructureTree } from '../../hooks/useStructure';
import { getSortedFlatDepartments } from '../../utils/departmentUtils';
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
  const { canEditPage, showActualHours } = useAuth();
  const canEdit = canEditPage('/employees') || canEditPage('/staff-control');

  // Deep-link: ?date=2026-03-18 — открыть календарь на конкретный месяц
  const urlDate = searchParams.get('date');

  const queryClient = useQueryClient();
  const empIdNum = Number(id);
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<EmployeeInput>>({});

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

  // Список объектов строительства для выбора поля «Объект» в форме правки.
  // Грузим только для тех, кто может редактировать; объекты меняются редко.
  const workObjectOptionsQuery = useQuery({
    queryKey: ['employee-work-object-options'],
    queryFn: () => employeeService.listWorkObjectOptions(),
    enabled: canEdit,
    staleTime: 30 * 60_000,
  });
  const workObjectOptions = workObjectOptionsQuery.data ?? [];

  // Структура (для редактирования отделов и модалки восстановления) — общий query key
  const structureQuery = useStructureTree(true);
  const rehireTargetDepartments = useMemo(() => {
    const tree = structureQuery.data?.departments ?? [];
    const archiveId = structureQuery.data?.stats.archive_department_id ?? null;
    return getSortedFlatDepartments(tree).filter(department => department.id !== archiveId);
  }, [structureQuery.data]);

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

  // Месячные СКУД-события грузим всегда: помимо fallback-режима без табеля,
  // они нужны для подсветки дней с проходами без записи в табеле (статус 'incomplete_skud').
  const skudEventsQuery = useQuery({
    queryKey: ['skud-employee-events', empIdNum, monthRange.startDate, monthRange.endDate],
    queryFn: () => skudService.getEmployeeEvents(empIdNum, monthRange.startDate, monthRange.endDate).catch(() => [] as SkudEvent[]),
    enabled: !!empIdNum && !Number.isNaN(empIdNum),
    staleTime: 60_000,
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

  const invalidateEmployee = useInvalidateEmployeeData();

  // Освежить карточку и сопутствующие данные (списки/дерево/счётчики),
  // чтобы изменения через карточку (rehire, редактирование ФИО и т.п.) сразу
  // отражались на /staff-control и в сайдбаре без F5.
  const reloadEmployee = useCallback(() => {
    invalidateEmployee(empIdNum);
    queryClient.invalidateQueries({ queryKey: ['employee-timesheet-summary', empIdNum] });
  }, [invalidateEmployee, queryClient, empIdNum]);

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
        monthSkudEvents: skudEvents,
        internalPoints,
        showActualHours,
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
    showActualHours,
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
    enabled: !!empIdNum && !Number.isNaN(empIdNum) && !!selectedCalDay,
    staleTime: selectedCalDay ? getDayEventsStaleTime(selectedCalDay) : 30_000,
  });
  // Ошибочные события Sigur (PASS_DENY и т.п.) за выбранный день — отдельный лёгкий
  // запрос. Не блокирует загрузку основных событий: failures показываются с маркером.
  const selectedDayFailuresQuery = useQuery({
    queryKey: ['skud-employee-failures-day', empIdNum, selectedCalDay],
    queryFn: () => skudService
      .getEventFailures({ employeeId: empIdNum, startDate: selectedCalDay!, endDate: selectedCalDay! })
      .then(r => r.data)
      .catch(() => []),
    enabled: !!empIdNum && !Number.isNaN(empIdNum) && !!selectedCalDay,
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
      work_object: employee.work_object,
      ...(isSigurLinked ? {} : {
        birth_date: employee.birth_date || undefined,
        current_salary: employee.current_salary,
        org_department_id: employee.org_department_id || undefined,
      }),
    });
    setIsEditing(true);
  };

  const saveEditing = async () => {
    if (!employee) return;
    try {
      const payload = employee.sigur_employee_id != null
        ? { full_name: editData.full_name || '', work_object: editData.work_object ?? null }
        : editData;
      await employeeService.update(employee.id, payload);
      setIsEditing(false);
      reloadEmployee();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  };

  const [rehireModalOpen, setRehireModalOpen] = useState(false);
  const [rehireDeptId, setRehireDeptId] = useState('');
  const [rehireInFlight, setRehireInFlight] = useState(false);

  const openRehireModal = () => {
    setRehireDeptId('');
    setRehireModalOpen(true);
  };

  const closeRehireModal = () => {
    if (rehireInFlight) return;
    setRehireModalOpen(false);
    setRehireDeptId('');
  };

  const handleConfirmRehire = async () => {
    if (!employee || !rehireDeptId) return;
    setRehireInFlight(true);
    try {
      await employeeService.rehire(employee.id, rehireDeptId);
      setRehireModalOpen(false);
      setRehireDeptId('');
      reloadEmployee();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Ошибка восстановления');
    } finally {
      setRehireInFlight(false);
    }
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
  const attendanceViewModel = (() => {
    const currentDate = new Date();
    const todayLocalStr = currentDate.toISOString().slice(0, 10);
    const showDate = selectedCalDay || todayLocalStr;
    const showEvents = selectedCalDay
      ? selectedDayEventsFast
      : [...todayEvents].sort((a, b) => a.event_time.localeCompare(b.event_time));
    const showFailures = selectedCalDay ? (selectedDayFailuresQuery.data ?? []) : [];
    const showEventsLoading = selectedCalDay
      ? selectedDayEventsQuery.isLoading && selectedDayEventsFast.length === 0
      : todayEventsQuery.isLoading && todayEvents.length === 0;
    const dayLabel = selectedCalDay
      ? new Date(`${selectedCalDay}T00:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
      : `Сегодня, ${currentDate.getDate()} ${MONTH_LABELS_GEN[currentDate.getMonth()]}`;

    return {
      showDate,
      showEvents,
      showFailures,
      showEventsLoading,
      dayLabel,
    };
  })();

  return (
    <div className="ec-content">
      {error && (
        <div className="ec-error-banner">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

      {/* ===== Back button (отдельной зоной, слева над шапкой) ===== */}
      <div className="ec-back-row">
        <button
          className="ec-back-btn"
          onClick={handleBack}
          aria-label={`Назад: ${backLabel}`}
        >
          <ArrowLeft size={18} />
          <span className="ec-back-btn-label">{backLabel}</span>
        </button>
      </div>

      {/* ===== Hero (полноширинная шапка) ===== */}
      <header className="ec-hero">
        <div className="ec-hero-inner">
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
                {employee.sigur_employee_id != null && (
                  <span className="ec-profile-id">Sigur ID: {employee.sigur_employee_id}</span>
                )}
              </div>
            </div>
            {canEdit && (
              <div className="ec-profile-actions">
                <button className="ec-action-btn" onClick={startEditing}>
                  <Edit3 size={16} /> {employee.sigur_employee_id != null ? 'Изменить ФИО' : 'Редактировать'}
                </button>
                {employee.employment_status === 'fired' && (
                  <button className="ec-action-btn" onClick={openRehireModal}>
                    <ShieldCheck size={16} /> Восстановить из уволенных
                  </button>
                )}
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

          {!attendanceLoading && (attendance?.alerts.length ?? 0) > 0 && (
            <div className="ec-hero-alerts">
              {attendance!.alerts.map((a, i) => (
                <span
                  key={i}
                  className={`ec-hero-alert ${a.type}`}
                  title={a.description}
                >
                  {a.type === 'warning' ? <Clock size={12} /> : <CalendarX size={12} />}
                  {a.title}
                </span>
              ))}
            </div>
          )}
        </div>
      </header>

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
          showFailures={attendanceViewModel.showFailures}
          showEventsLoading={attendanceViewModel.showEventsLoading}
          internalPoints={internalPoints}
          isEditing={isEditing}
          isSigurLinked={employee.sigur_employee_id != null}
          editData={editData}
          workObjectOptions={workObjectOptions}
          onEditDataChange={setEditData}
          onSave={saveEditing}
          onCancel={() => { setIsEditing(false); setEditData({}); }}
        />
      </Suspense>

      {rehireModalOpen && (
        <div className="ec-overlay" onClick={closeRehireModal}>
          <div className="ec-change-modal" onClick={event => event.stopPropagation()}>
            <div className="ec-change-modal-header">
              <h3>Восстановить из уволенных</h3>
              <button
                className="ec-change-modal-close"
                onClick={closeRehireModal}
                disabled={rehireInFlight}
              >
                ×
              </button>
            </div>
            <div className="ec-change-modal-body">
              <div className="ec-change-field">
                <label>Отдел для {employee.full_name}</label>
                <select
                  value={rehireDeptId}
                  onChange={event => setRehireDeptId(event.target.value)}
                  disabled={rehireInFlight || structureQuery.isLoading}
                >
                  <option value="">— Выберите отдел —</option>
                  {rehireTargetDepartments.map(department => (
                    <option key={department.id} value={department.id}>
                      {'  '.repeat(department.level)}{department.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="ec-change-modal-footer">
              <button
                className="ec-change-btn cancel"
                onClick={closeRehireModal}
                disabled={rehireInFlight}
              >
                Отмена
              </button>
              <button
                className="ec-change-btn apply"
                onClick={handleConfirmRehire}
                disabled={!rehireDeptId || rehireInFlight}
              >
                {rehireInFlight ? 'Восстанавливаем...' : 'Восстановить'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
