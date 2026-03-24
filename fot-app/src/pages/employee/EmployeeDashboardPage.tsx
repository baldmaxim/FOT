import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { apiClient } from '../../api/client';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import type { Employee, SkudEvent, IAccessPointSetting } from '../../types';
import { AttendanceCard } from '../../components/dashboard/AttendanceCard';
import { EmployeeInfoCards } from '../../components/dashboard/EmployeeInfoCards';
import { RequestModal, TwoFAModal } from '../../components/dashboard/RequestModals';
import styles from './EmployeeDashboard.module.css';

type RequestType = 'vacation' | 'sick' | 'remote' | 'docs';
type ViewPeriod = 'day' | 'week' | 'month';

const timeToMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface DayAttendance {
  date: string;
  dayName: string;
  firstEntry: string | null;
  lastExit: string | null;
  totalMinutes: number;
  isToday: boolean;
  isWeekend: boolean;
}

const buildWeekAttendance = (events: SkudEvent[], startDate: string): DayAttendance[] => {
  const start = new Date(startDate + 'T00:00:00');
  const todayStr = new Date().toISOString().slice(0, 10);
  const result: DayAttendance[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayEvents = events
      .filter((e) => e.event_date === dateStr)
      .sort((a, b) => a.event_time.localeCompare(b.event_time));

    const firstEntry = dayEvents.length > 0 ? dayEvents[0].event_time : null;
    const lastExit = dayEvents.length > 1 ? dayEvents[dayEvents.length - 1].event_time : null;
    const totalMinutes = firstEntry && lastExit
      ? Math.max(0, timeToMinutes(lastExit) - timeToMinutes(firstEntry))
      : 0;

    result.push({
      date: dateStr, dayName: DAY_NAMES[i], firstEntry, lastExit, totalMinutes,
      isToday: dateStr === todayStr, isWeekend: i >= 5,
    });
  }
  return result;
};

const getPeriodRange = (period: ViewPeriod, offset: number): { startDate: string; endDate: string; label: string } => {
  const today = new Date();

  if (period === 'day') {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    const dateStr = d.toISOString().slice(0, 10);
    const isToday = offset === 0;
    const label = isToday
      ? 'Сегодня'
      : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    return { startDate: dateStr, endDate: dateStr, label };
  }

  if (period === 'week') {
    const currentDay = today.getDay() === 0 ? 6 : today.getDay() - 1;
    const start = new Date(today);
    start.setDate(today.getDate() - currentDay + offset * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const label = `${start.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`;
    return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), label };
  }

  // month
  const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const label = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  return { startDate: d.toISOString().slice(0, 10), endDate: last.toISOString().slice(0, 10), label };
};

export const EmployeeDashboardPage: React.FC = () => {
  const { user, profile, refreshProfile, isTwoFactorEnabled } = useAuth();
  const { showToast } = useToast();
  const [activeModal, setActiveModal] = useState<RequestType | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [skudEvents, setSkudEvents] = useState<SkudEvent[]>([]);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Period navigation
  const [viewPeriod, setViewPeriod] = useState<ViewPeriod>('day');
  const [periodOffset, setPeriodOffset] = useState(0);

  // 2FA state
  const [show2FASetup, setShow2FASetup] = useState(false);
  const [twoFAData, setTwoFAData] = useState<{ secret: string; qrCode: string; recoveryCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [isEnabling2FA, setIsEnabling2FA] = useState(false);

  const periodRange = useMemo(() => getPeriodRange(viewPeriod, periodOffset), [viewPeriod, periodOffset]);

  // Initial load: employee + access point settings
  useEffect(() => {
    const load = async () => {
      if (!profile?.employee_id) { setLoading(false); return; }
      try {
        const [emp, apSettings] = await Promise.all([
          employeeService.getById(profile.employee_id),
          skudService.getAccessPointSettings().catch(() => [] as IAccessPointSetting[]),
        ]);
        setEmployee(emp);
        setInternalPoints(new Set(apSettings.filter(s => s.is_internal).map(s => s.access_point_name)));
      } catch (e) {
        console.error('Failed to load employee data:', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [profile?.employee_id]);

  // Load SKUD events when period changes
  const loadEvents = useCallback(async (empId: number, start: string, end: string) => {
    setEventsLoading(true);
    try {
      const events = await skudService.getEmployeeEvents(empId, start, end);
      setSkudEvents(events);
    } catch (e) {
      console.error('Failed to load events:', e);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!profile?.employee_id) return;
    loadEvents(profile.employee_id, periodRange.startDate, periodRange.endDate);
  }, [profile?.employee_id, periodRange.startDate, periodRange.endDate, loadEvents]);

  // Build display data
  const weekStartDate = useMemo(() => {
    if (viewPeriod === 'week') return periodRange.startDate;
    const today = new Date();
    const currentDay = today.getDay() === 0 ? 6 : today.getDay() - 1;
    const start = new Date(today);
    start.setDate(today.getDate() - currentDay);
    return start.toISOString().slice(0, 10);
  }, [viewPeriod, periodRange.startDate]);

  const weekData = useMemo(
    () => buildWeekAttendance(skudEvents, viewPeriod === 'week' ? periodRange.startDate : weekStartDate),
    [skudEvents, viewPeriod, periodRange.startDate, weekStartDate]
  );

  const dayEvents = useMemo(() => {
    const dateStr = viewPeriod === 'day' ? periodRange.startDate : new Date().toISOString().slice(0, 10);
    return skudEvents
      .filter((e) => e.event_date === dateStr)
      .sort((a, b) => a.event_time.localeCompare(b.event_time));
  }, [skudEvents, viewPeriod, periodRange.startDate]);

  const dayData = useMemo(() => {
    const first = dayEvents.length > 0 ? dayEvents[0].event_time : null;
    const last = dayEvents.length > 1 ? dayEvents[dayEvents.length - 1].event_time : null;
    const totalMinutes = first && last ? Math.max(0, timeToMinutes(last) - timeToMinutes(first)) : 0;
    return { firstEntry: first, lastExit: last, totalMinutes };
  }, [dayEvents]);

  const monthDays = useMemo(() => {
    if (viewPeriod !== 'month') return [];
    const start = new Date(periodRange.startDate + 'T00:00:00');
    const end = new Date(periodRange.endDate + 'T00:00:00');
    const todayStr = new Date().toISOString().slice(0, 10);
    const days: DayAttendance[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const dayEvts = skudEvents
        .filter(e => e.event_date === dateStr)
        .sort((a, b) => a.event_time.localeCompare(b.event_time));
      const firstEntry = dayEvts.length > 0 ? dayEvts[0].event_time : null;
      const lastExit = dayEvts.length > 1 ? dayEvts[dayEvts.length - 1].event_time : null;
      const totalMinutes = firstEntry && lastExit
        ? Math.max(0, timeToMinutes(lastExit) - timeToMinutes(firstEntry)) : 0;
      const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
      days.push({ date: dateStr, dayName: DAY_NAMES[dow], firstEntry, lastExit, totalMinutes, isToday: dateStr === todayStr, isWeekend: dow >= 5 });
    }
    return days;
  }, [viewPeriod, periodRange, skudEvents]);

  const isCurrentPeriod = periodOffset === 0;

  const getEventColor = useCallback((event: SkudEvent) => {
    const isInternal = event.access_point ? internalPoints.has(event.access_point) : false;
    if (isInternal) return { dot: styles.skudInternal, badge: styles.statusGray, label: 'Внутр.' };
    const dir = event.direction?.toLowerCase() || '';
    const isEntry = dir.includes('вход') || dir.includes('in') || event.direction === '1' || dir === 'entry';
    const isExit = dir.includes('выход') || dir.includes('out') || event.direction === '0' || dir === 'exit';
    if (isEntry) return { dot: styles.skudEntry, badge: styles.approved, label: 'Вход' };
    if (isExit) return { dot: styles.skudExit, badge: styles.statusRed, label: 'Выход' };
    return { dot: styles.skudInternal, badge: styles.statusGray, label: 'Событие' };
  }, [internalPoints]);

  const handleSetup2FA = async () => {
    try {
      const data = await apiClient.post<{ secret: string; qrCode: string; recoveryCodes: string[] }>('/auth/2fa/setup');
      setTwoFAData(data);
      setShow2FASetup(true);
    } catch {
      showToast('error', 'Ошибка при настройке 2FA');
    }
  };

  const handleEnable2FA = async () => {
    if (!verifyCode.trim()) { showToast('error', 'Введите код'); return; }
    setIsEnabling2FA(true);
    try {
      await apiClient.post('/auth/2fa/enable', { code: verifyCode });
      await refreshProfile();
      setShow2FASetup(false); setTwoFAData(null); setVerifyCode('');
      showToast('success', '2FA включена');
    } catch {
      showToast('error', 'Неверный код');
    } finally {
      setIsEnabling2FA(false);
    }
  };

  const handleDisable2FA = async () => {
    if (!confirm('Отключить двухфакторную аутентификацию?')) return;
    try {
      await apiClient.post('/auth/2fa/disable');
      await refreshProfile();
      showToast('success', '2FA отключена');
    } catch {
      showToast('error', 'Ошибка при отключении 2FA');
    }
  };

  return (
    <div className={styles.content}>
      {/* Quick Actions */}
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Подать заявление</h2>
      </div>
      <div className={styles.quickActionsGrid}>
        {(['vacation','sick','remote','docs'] as RequestType[]).map((type) => (
          <div key={type} className={styles.quickActionCard} onClick={() => setActiveModal(type)}>
            <div className={`${styles.quickActionIcon} ${styles[type]}`}>
              {type === 'vacation' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>}
              {type === 'sick' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>}
              {type === 'remote' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>}
              {type === 'docs' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>}
            </div>
            <div className={styles.quickActionTitle}>{type === 'vacation' ? 'Отпуск' : type === 'sick' ? 'Больничный' : type === 'remote' ? 'Удалёнка' : 'Справка'}</div>
            <div className={styles.quickActionDesc}>{type === 'vacation' ? 'Ежегодный оплачиваемый' : type === 'sick' ? 'Листок нетрудоспособности' : type === 'remote' ? 'Работа из дома' : 'Запросить документ'}</div>
          </div>
        ))}
      </div>

      {/* Content Grid */}
      <div className={styles.contentGrid}>
        <AttendanceCard
          loading={loading}
          eventsLoading={eventsLoading}
          viewPeriod={viewPeriod}
          setViewPeriod={setViewPeriod}
          setPeriodOffset={setPeriodOffset}
          periodLabel={periodRange.label}
          isCurrentPeriod={isCurrentPeriod}
          dayEvents={dayEvents}
          dayData={dayData}
          weekData={weekData}
          monthDays={monthDays}
          getEventColor={getEventColor}
        />

        <EmployeeInfoCards
          loading={loading}
          employee={employee}
          importedPosition={profile?.imported_position ?? undefined}
          email={user?.email ?? undefined}
          isTwoFactorEnabled={isTwoFactorEnabled}
          onSetup2FA={handleSetup2FA}
          onDisable2FA={handleDisable2FA}
        />
      </div>

      {/* 2FA Setup Modal */}
      {show2FASetup && twoFAData && (
        <TwoFAModal
          twoFAData={twoFAData}
          verifyCode={verifyCode}
          setVerifyCode={setVerifyCode}
          isEnabling2FA={isEnabling2FA}
          onEnable={handleEnable2FA}
          onClose={() => setShow2FASetup(false)}
        />
      )}

      {/* Request Modals */}
      {activeModal && (
        <RequestModal activeModal={activeModal} onClose={() => setActiveModal(null)} />
      )}
    </div>
  );
};
