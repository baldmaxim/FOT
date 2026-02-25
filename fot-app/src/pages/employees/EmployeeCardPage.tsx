import { useState, useEffect, useCallback, useMemo, type FC } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft, Edit3, Archive, RotateCcw, Trash2,
  Briefcase, FolderOpen, CalendarDays, CheckCircle,
  Clock, DollarSign, BarChart3, LogIn, LogOut,
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
import {
  calculateAttendance, getTodayTimeline, isEmployeeOnSite,
} from '../../utils/attendanceCalc';
import type { Employee, EmployeeInput, EmployeeHistoryEvent, OrgDepartmentNode, SkudEvent } from '../../types';
import '../../styles/EmployeeCardPage.css';
import '../../styles/EmployeeCardV2.css';

type Tab = 'attendance' | 'info' | 'history' | 'skud';
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

export const EmployeeCardPage: FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const backLabel = (location.state as { label?: string })?.label || 'Сотрудники';
  const { canAccess } = useAuth();
  const canEdit = canAccess('header');

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [history, setHistory] = useState<EmployeeHistoryEvent[]>([]);
  const [departments, setDepartments] = useState<OrgDepartmentNode[]>([]);
  const [skudEvents, setSkudEvents] = useState<SkudEvent[]>([]);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('attendance');
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<EmployeeInput>>({});

  // Calendar month
  const now = new Date();
  const [calMonth, setCalMonth] = useState(now.getMonth());
  const [calYear, setCalYear] = useState(now.getFullYear());

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
    if (!employee?.org_department_id) { setInternalPoints(new Set()); return; }
    skudService.getAccessPointSettings(employee.org_department_id).then(settings => {
      setInternalPoints(new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name.trim())));
    }).catch(() => {});
  }, [employee?.org_department_id]);

  // Load SKUD events for selected month
  useEffect(() => {
    if (!id) return;
    const startDate = new Date(calYear, calMonth, 1).toISOString().slice(0, 10);
    const endDate = new Date(calYear, calMonth + 1, 0).toISOString().slice(0, 10);
    skudService.getEmployeeEvents(Number(id), startDate, endDate)
      .then(setSkudEvents)
      .catch(() => setSkudEvents([]));
  }, [id, calMonth, calYear]);

  // Calculated attendance data
  const attendance = useMemo(
    () => calculateAttendance(skudEvents, internalPoints, calYear, calMonth),
    [skudEvents, internalPoints, calYear, calMonth],
  );
  const todayTimeline = useMemo(() => getTodayTimeline(skudEvents), [skudEvents]);
  const onSite = useMemo(() => isEmployeeOnSite(skudEvents, internalPoints), [skudEvents, internalPoints]);

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

  const handleMoveDepartment = async (departmentId: string) => {
    if (!employee) return;
    try { await employeeService.moveDepartment(employee.id, departmentId); loadData(); }
    catch { setError('Ошибка перемещения в отдел'); }
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

  const { stats } = attendance;
  const todayLabel = `${now.getDate()} ${MONTH_LABELS_GEN[now.getMonth()]}`;

  return (
    <div className="ec-content">
      {error && (
        <div className="ec-error-banner">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

      {/* ===== Back Button ===== */}
      <button className="ec-back-btn" onClick={() => navigate(-1)}>
        <ArrowLeft size={16} />
        {backLabel}
      </button>

      {/* ===== Profile Header ===== */}
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
          <div className="ec-profile-meta">
            {employee.position_name && (
              <div className="ec-meta-item">
                <Briefcase size={16} />
                {employee.position_name}
              </div>
            )}
            {employee.department && (
              <div className="ec-meta-item clickable">
                <FolderOpen size={16} />
                {employee.department}
              </div>
            )}
            <div className="ec-meta-item">
              <CalendarDays size={16} />
              В компании с {formatHireDate(employee.hire_date)}
            </div>
          </div>
          <div className="ec-profile-id">ID: {employee.id}</div>
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

      {/* ===== Stats Row ===== */}
      <div className="ec-stats-row">
        <div className="ec-stat-card">
          <div className="ec-stat-header">
            <span className="ec-stat-label">Посещаемость</span>
            <div className="ec-stat-icon green"><CheckCircle size={18} /></div>
          </div>
          <div className="ec-stat-value">{stats.attendancePercent}%</div>
          <div className="ec-stat-trend neutral">за текущий месяц</div>
        </div>
        <div className="ec-stat-card">
          <div className="ec-stat-header">
            <span className="ec-stat-label">Опозданий за месяц</span>
            <div className="ec-stat-icon orange"><Clock size={18} /></div>
          </div>
          <div className="ec-stat-value">{stats.lateCount}</div>
          <div className={`ec-stat-trend ${stats.lateCount > 2 ? 'down' : 'neutral'}`}>
            {stats.lateCount > 2 ? 'превышен лимит' : 'в пределах нормы'}
          </div>
        </div>
        <div className="ec-stat-card">
          <div className="ec-stat-header">
            <span className="ec-stat-label">Отработано часов</span>
            <div className="ec-stat-icon blue"><DollarSign size={18} /></div>
          </div>
          <div className="ec-stat-value">{stats.hoursWorked}ч</div>
          <div className="ec-stat-trend neutral">из {stats.hoursPlanned}ч по плану</div>
        </div>
        <div className="ec-stat-card">
          <div className="ec-stat-header">
            <span className="ec-stat-label">Ср. время прихода</span>
            <div className="ec-stat-icon purple"><BarChart3 size={18} /></div>
          </div>
          <div className="ec-stat-value">{stats.avgArrivalTime || '—'}</div>
          <div className={`ec-stat-trend ${stats.avgArrivalDiffMinutes > 0 ? 'down' : 'up'}`}>
            {stats.avgArrivalDiffMinutes > 0
              ? `+${stats.avgArrivalDiffMinutes} мин к норме`
              : stats.avgArrivalDiffMinutes < 0
                ? `${stats.avgArrivalDiffMinutes} мин к норме`
                : 'точно в норме'}
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
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ===== Tab Content ===== */}
      {activeTab === 'attendance' && (
        <div className="ec-grid">
          <div>
            <AttendanceCalendar
              days={attendance.days}
              month={calMonth}
              year={calYear}
              onPrevMonth={prevMonth}
              onNextMonth={nextMonth}
            />
            {/* Today's Timeline */}
            <div className="ec-card" style={{ marginTop: 16 }}>
              <div className="ec-card-header">
                <div className="ec-card-title">
                  <Clock size={18} />
                  Сегодня, {todayLabel}
                </div>
              </div>
              {todayTimeline.length > 0 ? (
                <div className="ec-timeline">
                  {todayTimeline.map(ev => (
                    <div key={ev.id} className="ec-tl-item">
                      <div className={`ec-tl-icon ${ev.direction === 'entry' ? 'in' : 'out'}`}>
                        {ev.direction === 'entry' ? <LogIn size={16} /> : <LogOut size={16} />}
                      </div>
                      <div className="ec-tl-content">
                        <div className="ec-tl-title">
                          {ev.direction === 'entry' ? 'Вход' : 'Выход'}
                        </div>
                        <div className="ec-tl-meta">{ev.accessPoint || 'Точка доступа'}</div>
                      </div>
                      <div className="ec-tl-time">{ev.time}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ec-tl-empty">Нет событий за сегодня</div>
              )}
            </div>
          </div>
          <EmployeeCardSidebar
            weeklyPattern={attendance.weeklyPattern}
            alerts={attendance.alerts}
            employee={employee}
          />
        </div>
      )}

      {activeTab === 'info' && (
        <div className="ec-tab-content-full">
          <EmployeeInfoSection
            employee={employee}
            isEditing={isEditing}
            editData={editData}
            onEditDataChange={setEditData}
            onSave={saveEditing}
            onCancel={() => { setIsEditing(false); setEditData({}); }}
            departments={departments}
            onMoveDepartment={handleMoveDepartment}
            canEdit={canEdit}
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
          departmentId={employee.org_department_id || undefined}
        />
      )}
    </div>
  );
};
