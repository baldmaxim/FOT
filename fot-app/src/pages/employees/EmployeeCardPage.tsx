import { useState, useEffect, useCallback, useMemo, type FC } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Edit3, Archive, RotateCcw, Trash2,
  Briefcase, FolderOpen, CalendarDays, CheckCircle,
  Clock, DollarSign, BarChart3, LogIn, LogOut,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import { structureApi } from '../../api/structure';
import { useAuth } from '../../contexts/AuthContext';
import { EmployeeInfoSection } from '../../components/employees/EmployeeInfoSection';
import { EmployeeHistorySection } from '../../components/employees/EmployeeHistorySection';
import { EmployeeSkudSection } from '../../components/employees/EmployeeSkudSection';
import { AttendanceCalendar } from '../../components/employees/AttendanceCalendar';
import { EmployeeCardSidebar } from '../../components/employees/EmployeeCardSidebar';
import { DateInput } from '../../components/ui/DateInput';
import {
  calculateAttendance, isEmployeeOnSite, computePeriodData,
} from '../../utils/attendanceCalc';
import type { Employee, EmployeeInput, EmployeeHistoryEvent, OrgDepartmentNode, SkudEvent } from '../../types';
import '../../styles/EmployeeCardPage.css';
import '../../styles/EmployeeCardV2.css';

type Tab = 'attendance' | 'info' | 'history' | 'skud';
type ViewPeriod = 'today' | 'week' | 'month' | 'range';
const PERIOD_LABELS: Record<ViewPeriod, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
  range: 'Период',
};
const STATS_TREND_LABELS: Record<ViewPeriod, string> = {
  today: 'за сегодня',
  week: 'за неделю',
  month: 'за текущий месяц',
  range: 'за текущий месяц',
};
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

const navigateViewDate = (period: ViewPeriod, dateStr: string, dir: number): string => {
  const d = parseISO(dateStr);
  if (period === 'today') d.setDate(d.getDate() + dir);
  else if (period === 'week') d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir);
  return toLocalISO(d);
};

const getViewLabel = (period: ViewPeriod, dateStr: string): string => {
  const d = parseISO(dateStr);
  if (period === 'today') {
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
  const [searchParams] = useSearchParams();
  const backLabel = (location.state as { label?: string })?.label || 'Сотрудники';
  const { canAccess } = useAuth();
  const canEdit = canAccess('admin');

  // Deep-link: ?tab=skud&date=2026-03-18
  const urlTab = searchParams.get('tab') as Tab | null;
  const urlDate = searchParams.get('date');

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [history, setHistory] = useState<EmployeeHistoryEvent[]>([]);
  const [, setDepartments] = useState<OrgDepartmentNode[]>([]);
  const [skudEvents, setSkudEvents] = useState<SkudEvent[]>([]);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>(urlTab && ['attendance', 'info', 'history', 'skud'].includes(urlTab) ? urlTab : 'attendance');
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<EmployeeInput>>({});
  const [viewPeriod, setViewPeriod] = useState<ViewPeriod>('month');
  const [rangeStart, setRangeStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [rangeEnd, setRangeEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [skudViewDate, setSkudViewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [skudFocusDate, setSkudFocusDate] = useState<string | null>(urlDate || null);
  const [skudFocusKey] = useState(urlDate ? 1 : 0);

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

  // Load employee + structure
  const loadData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const [emp, hist, struct] = await Promise.all([
        employeeService.getById(Number(id)),
        employeeService.getHistory(Number(id)).catch(() => [] as EmployeeHistoryEvent[]),
        structureApi.getTree().catch(() => null),
      ]);
      setEmployee(emp);
      setHistory(hist);
      if (struct?.data?.departments) setDepartments(struct.data.departments);
    } catch {
      setError('Ошибка загрузки данных сотрудника');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  // Load internal access points
  useEffect(() => {
    skudService.getAccessPointSettings().then(settings => {
      setInternalPoints(new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name.trim())));
    }).catch(() => {});
  }, []);

  // Load SKUD events for selected month
  const [skudRefresh, setSkudRefresh] = useState(0);
  const reloadSkudEvents = useCallback(() => setSkudRefresh(n => n + 1), []);

  useEffect(() => {
    if (!id) return;
    const startDate = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-01`;
    const endDate = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(new Date(calYear, calMonth + 1, 0).getDate()).padStart(2, '0')}`;
    skudService.getEmployeeEvents(Number(id), startDate, endDate)
      .then(setSkudEvents)
      .catch(() => setSkudEvents([]));
  }, [id, calMonth, calYear, skudRefresh]);

  // Отдельная загрузка событий сегодняшнего дня для статуса (не зависит от выбранного месяца)
  const [todayEvents, setTodayEvents] = useState<SkudEvent[]>([]);
  useEffect(() => {
    if (!id) return;
    const today = new Date().toISOString().slice(0, 10);
    skudService.getEmployeeEvents(Number(id), today, today)
      .then(setTodayEvents)
      .catch(() => setTodayEvents([]));
  }, [id, skudRefresh]);

  // Calculated attendance data
  const attendance = useMemo(
    () => calculateAttendance(skudEvents, internalPoints, calYear, calMonth),
    [skudEvents, internalPoints, calYear, calMonth],
  );
  const onSite = useMemo(() => isEmployeeOnSite(todayEvents, internalPoints), [todayEvents, internalPoints]);

  // Period-filtered stats + weekly pattern
  const statsPeriod = viewPeriod === 'range' ? 'month' : viewPeriod;
  const periodData = useMemo(() => {
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

  // Calendar day click → SKUD tab
  const [selectedCalDay, setSelectedCalDay] = useState<string | null>(null);

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

  // Actions
  const startEditing = () => {
    if (!employee) return;
    setEditData({
      full_name: employee.full_name,
      hire_date: employee.hire_date,
      birth_date: employee.birth_date || undefined,
      current_salary: employee.current_salary,
      org_department_id: employee.org_department_id || undefined,
    });
    setIsEditing(true);
    setActiveTab('info');
  };

  const saveEditing = async () => {
    if (!employee) return;
    try { await employeeService.update(employee.id, editData); setIsEditing(false); loadData(); }
    catch { setError('Ошибка сохранения'); }
  };

  const handleArchive = async () => {
    if (!employee || !confirm('Перевести сотрудника в архив?')) return;
    try { await employeeService.archive(employee.id); loadData(); }
    catch { setError('Ошибка архивации'); }
  };

  const handleRestore = async () => {
    if (!employee) return;
    try { await employeeService.restore(employee.id); loadData(); }
    catch { setError('Ошибка восстановления'); }
  };

  const handleDelete = async () => {
    if (!employee || !confirm('Удалить сотрудника? Это действие необратимо.')) return;
    try { await employeeService.delete(employee.id); navigate(-1); }
    catch { setError('Ошибка удаления'); }
  };

  // Loading / Error states
  if (loading) return <div className="ec-content"><div className="ec-loading">Загрузка...</div></div>;
  if (error && !employee) {
    return (
      <div className="ec-content">
        <div className="ec-error">
          <p>{error}</p>
          <button className="btn-back-link" onClick={() => navigate(-1)}>
            <ArrowLeft size={16} /> Назад к списку
          </button>
        </div>
      </div>
    );
  }
  if (!employee) return null;

  const { stats: pStats } = periodData;
  const todayLabel = `${now.getDate()} ${MONTH_LABELS_GEN[now.getMonth()]}`;

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
        <button className="ec-back-btn" onClick={() => navigate(-1)}>
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
                <Edit3 size={16} /> Редактировать
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

        {/* Stats */}
        <div className="ec-stats-period-row">
          <div className="ec-stats-period-selector">
            {(['today', 'week', 'month', 'range'] as ViewPeriod[]).map(p => (
              <button
                key={p}
                className={`ec-stats-period-btn ${viewPeriod === p ? 'active' : ''}`}
                onClick={() => { setViewPeriod(p); if (p !== 'range') setSkudViewDate(new Date().toISOString().slice(0, 10)); }}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
          {viewPeriod === 'range' ? (
            <div className="ec-range-inputs">
              <DateInput value={rangeStart} onChange={setRangeStart} />
              <span className="ec-range-sep">—</span>
              <DateInput value={rangeEnd} onChange={setRangeEnd} />
            </div>
          ) : (
            <div className="ec-date-nav">
              <button className="ec-date-nav-btn" onClick={() => setSkudViewDate(s => navigateViewDate(viewPeriod, s, -1))}>
                <ChevronLeft size={16} />
              </button>
              <span className="ec-date-nav-label">{getViewLabel(viewPeriod, skudViewDate)}</span>
              <button className="ec-date-nav-btn" onClick={() => setSkudViewDate(s => navigateViewDate(viewPeriod, s, 1))}>
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
        <div className="ec-stats-row">
          <div className="ec-stat-card">
            <div className="ec-stat-header">
              <span className="ec-stat-label">Посещаемость</span>
              <div className="ec-stat-icon green"><CheckCircle size={14} /></div>
            </div>
            <div className="ec-stat-value">{pStats.attendancePercent}%</div>
            <div className="ec-stat-trend neutral">{STATS_TREND_LABELS[viewPeriod]}</div>
          </div>
          <div className="ec-stat-card">
            <div className="ec-stat-header">
              <span className="ec-stat-label">Опозданий</span>
              <div className="ec-stat-icon orange"><Clock size={14} /></div>
            </div>
            <div className="ec-stat-value">{pStats.lateCount}</div>
            <div className={`ec-stat-trend ${pStats.lateCount > 2 ? 'down' : 'neutral'}`}>
              {pStats.lateCount > 2 ? 'превышен лимит' : 'в пределах нормы'}
            </div>
          </div>
          <div className="ec-stat-card">
            <div className="ec-stat-header">
              <span className="ec-stat-label">Отработано часов</span>
              <div className="ec-stat-icon blue"><DollarSign size={14} /></div>
            </div>
            <div className="ec-stat-value">{pStats.hoursWorked}ч</div>
            <div className="ec-stat-trend neutral">из {pStats.hoursPlanned}ч по плану</div>
          </div>
          <div className="ec-stat-card">
            <div className="ec-stat-header">
              <span className="ec-stat-label">Ср. время прихода</span>
              <div className="ec-stat-icon purple"><BarChart3 size={14} /></div>
            </div>
            <div className="ec-stat-value">{pStats.avgArrivalTime || '—'}</div>
            <div className={`ec-stat-trend ${pStats.avgArrivalDiffMinutes > 0 ? 'down' : 'up'}`}>
              {pStats.avgArrivalDiffMinutes > 0
                ? `+${pStats.avgArrivalDiffMinutes} мин к норме`
                : pStats.avgArrivalDiffMinutes < 0
                  ? `${pStats.avgArrivalDiffMinutes} мин к норме`
                  : 'точно в норме'}
            </div>
          </div>
        </div>
      </div>

      {/* ===== Tabs ===== */}
      <div className="ec-tabs-container">
        <div className="ec-tabs">
          {TABS.map(t => (
            <button
              key={t.key}
              className={`ec-tab ${activeTab === t.key ? 'active' : ''}`}
              onClick={() => { setActiveTab(t.key); setSkudFocusDate(null); }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ===== Tab Content ===== */}
      {activeTab === 'attendance' && (() => {
        // Показываемые события: выбранный день или сегодня
        const showDate = selectedCalDay || new Date().toISOString().slice(0, 10);
        const showEvents = selectedCalDay ? selectedDayEvents : todayEvents.filter(e => !e.access_point || !internalPoints.has(e.access_point)).sort((a, b) => a.event_time.localeCompare(b.event_time));
        const dayLabel = selectedCalDay
          ? new Date(selectedCalDay + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
          : `Сегодня, ${todayLabel}`;

        const timeToSec = (t: string) => { const [h, m, s = 0] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
        const fmtHM = (mins: number) => { const h = Math.floor(mins / 60); const m = mins % 60; return h === 0 ? `${m} мин` : m === 0 ? `${h} ч` : `${h} ч ${m} мин`; };
        const todayStr = new Date().toISOString().slice(0, 10);
        const isToday = showDate === todayStr;

        // Построение пар вход/выход
        const pairs: { entry: SkudEvent; exit: SkudEvent | null; durationMinutes: number }[] = [];
        let currentEntry: SkudEvent | null = null;
        let totalSec = 0;
        for (const ev of showEvents) {
          if (ev.direction === 'entry') {
            if (!currentEntry) currentEntry = ev;
          } else if (ev.direction === 'exit' && currentEntry) {
            const dur = timeToSec(ev.event_time) - timeToSec(currentEntry.event_time);
            totalSec += dur;
            pairs.push({ entry: currentEntry, exit: ev, durationMinutes: Math.round(dur / 60) });
            currentEntry = null;
          }
        }
        if (currentEntry && isToday) {
          const now = new Date();
          const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
          const dur = nowSec - timeToSec(currentEntry.event_time);
          if (dur > 0) { totalSec += dur; pairs.push({ entry: currentEntry, exit: null, durationMinutes: Math.round(dur / 60) }); }
        }

        const workCalc = totalSec > 0 ? `${Math.floor(totalSec / 3600)}ч ${Math.floor((totalSec % 3600) / 60)}м` : null;
        const firstEntry = showEvents.find(e => e.direction === 'entry')?.event_time?.slice(0, 5) || null;
        const lastExit = [...showEvents].reverse().find(e => e.direction === 'exit')?.event_time?.slice(0, 5) || null;

        // Время «не на работе» — разрывы между выходом и следующим входом
        let absentSec = 0;
        for (let i = 0; i < pairs.length - 1; i++) {
          const exitTime = pairs[i].exit?.event_time;
          const nextEntry = pairs[i + 1].entry.event_time;
          if (exitTime) absentSec += timeToSec(nextEntry) - timeToSec(exitTime);
        }
        const absentCalc = absentSec > 0 ? `${Math.floor(absentSec / 3600)}ч ${Math.floor((absentSec % 3600) / 60)}м` : null;

        return (
          <div className="ec-grid">
            <div className="ec-attendance-row">
              <div className="ec-today-col">
                <div className="ec-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div className="ec-card-header">
                    <div className="ec-card-title">
                      <Clock size={18} />
                      {dayLabel}
                    </div>
                  </div>
                  {showEvents.length > 0 ? (
                    <div className="ec-today-events">
                      {pairs.length > 0 ? pairs.map((pair, i) => (
                        <div key={i} className="ec-pair-block">
                          <div className="ec-event-row">
                            <span className="ec-event-icon ec-event-entry">→</span>
                            <span className="ec-event-time">{pair.entry.event_time.slice(0, 5)}</span>
                            <span className="ec-event-dir">Вход</span>
                            {pair.entry.access_point && <span className="ec-event-point">{pair.entry.access_point}</span>}
                          </div>
                          {pair.exit ? (
                            <div className="ec-event-row">
                              <span className="ec-event-icon ec-event-exit">←</span>
                              <span className="ec-event-time">{pair.exit.event_time.slice(0, 5)}</span>
                              <span className="ec-event-dir">Выход</span>
                              {pair.exit.access_point && <span className="ec-event-point">{pair.exit.access_point}</span>}
                            </div>
                          ) : (
                            <div className="ec-event-row">
                              <span className="ec-event-icon ec-event-entry">→</span>
                              <span className="ec-event-time">—</span>
                              <span className="ec-event-dir ec-on-site">на месте</span>
                            </div>
                          )}
                          {pair.durationMinutes > 0 && (
                            <div className="ec-pair-duration">{fmtHM(pair.durationMinutes)}</div>
                          )}
                        </div>
                      )) : showEvents.map((ev, i) => (
                        <div key={i} className="ec-event-row">
                          <span className={`ec-event-icon ${ev.direction === 'entry' ? 'ec-event-entry' : 'ec-event-exit'}`}>
                            {ev.direction === 'entry' ? '→' : '←'}
                          </span>
                          <span className="ec-event-time">{ev.event_time.slice(0, 5)}</span>
                          <span className="ec-event-dir">{ev.direction === 'entry' ? 'Вход' : 'Выход'}</span>
                          {ev.access_point && <span className="ec-event-point">{ev.access_point}</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="ec-tl-empty" style={{ flex: 1 }}>Нет событий</div>
                  )}
                  {workCalc && (
                    <div className="ec-today-footer">
                      {firstEntry && (
                        <div className="ec-today-badge ec-today-badge-entry">
                          <LogIn size={14} />
                          <span>{firstEntry}</span>
                        </div>
                      )}
                      {lastExit && (
                        <div className="ec-today-badge ec-today-badge-exit">
                          <LogOut size={14} />
                          <span>{lastExit}</span>
                        </div>
                      )}
                      {absentCalc && (
                        <div className="ec-today-badge ec-today-badge-absent">
                          <span>Перерыв: {absentCalc}</span>
                        </div>
                      )}
                      <div className="ec-today-total">
                        {workCalc}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="ec-calendar-col">
                <AttendanceCalendar
                  days={attendance.days}
                  month={calMonth}
                  year={calYear}
                  onPrevMonth={prevMonth}
                  onNextMonth={nextMonth}
                  onDayClick={handleDayClick}
                />
              </div>
            </div>
            <EmployeeCardSidebar
              weeklyPattern={periodData.weeklyPattern}
              alerts={attendance.alerts}
              employee={employee}
            />
          </div>
        );
      })()}

      {activeTab === 'info' && (
        <div className="ec-tab-content-full">
          <EmployeeInfoSection
            employee={employee}
            isEditing={isEditing}
            editData={editData}
            onEditDataChange={setEditData}
            onSave={saveEditing}
            onCancel={() => { setIsEditing(false); setEditData({}); }}
          />
        </div>
      )}

      {activeTab === 'history' && (
        <div className="ec-tab-content-full">
          <EmployeeHistorySection history={history} />
        </div>
      )}

      {activeTab === 'skud' && (
        <EmployeeSkudSection
          employeeId={employee.id}
          employeeName={employee.full_name}
          departmentId={employee.org_department_id || undefined}
          onSync={reloadSkudEvents}
          focusDate={skudFocusDate}
          focusKey={skudFocusKey}
          externalViewMode={viewPeriod === 'today' ? 'day' : viewPeriod}
          externalRangeStart={rangeStart}
          externalRangeEnd={rangeEnd}
          externalViewDate={skudViewDate}
        />
      )}
    </div>
  );
};
