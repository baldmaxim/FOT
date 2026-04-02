import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { apiClient } from '../../api/client';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import type { Employee, SkudEvent, IAccessPointSetting } from '../../types';
import { AttendanceCard } from '../../components/dashboard/AttendanceCard';
import type { IDayGroup, IEntryExitPair } from '../../components/dashboard/AttendanceCard';
import { EmployeeInfoCards } from '../../components/dashboard/EmployeeInfoCards';
import { RequestModal, TwoFAModal } from '../../components/dashboard/RequestModals';
import styles from './EmployeeDashboard.module.css';

type RequestType = 'vacation' | 'sick' | 'remote' | 'docs';
type ViewPeriod = 'day' | 'week' | 'month';

const timeToSeconds = (t: string): number => {
  const [h, m, s = 0] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

const toLocalISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const buildPairs = (events: SkudEvent[], internalPoints: Set<string>, isToday: boolean): IEntryExitPair[] => {
  const ext = events.filter(e => !e.access_point || !internalPoints.has(e.access_point));
  const sorted = ext.length > 0 ? ext : events;
  const pairs: IEntryExitPair[] = [];
  let currentEntry: SkudEvent | null = null;

  for (const ev of sorted) {
    if (ev.direction === 'entry') {
      if (currentEntry === null) currentEntry = ev;
    } else if (ev.direction === 'exit' && currentEntry !== null) {
      const dur = timeToSeconds(ev.event_time) - timeToSeconds(currentEntry.event_time);
      pairs.push({ entry: currentEntry, exit: ev, durationMinutes: Math.round(dur / 60) });
      currentEntry = null;
    }
  }
  if (currentEntry && isToday) {
    const now = new Date();
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const dur = nowSec - timeToSeconds(currentEntry.event_time);
    if (dur > 0) {
      pairs.push({ entry: currentEntry, exit: null, durationMinutes: Math.round(dur / 60) });
    }
  }
  return pairs;
};

const buildDayGroups = (
  events: SkudEvent[],
  startDate: string,
  endDate: string,
  internalPoints: Set<string>,
): IDayGroup[] => {
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const todayStr = toLocalISO(new Date());
  const groups: IDayGroup[] = [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = toLocalISO(d);
    const dayEvents = events
      .filter(e => e.event_date === dateStr)
      .sort((a, b) => a.event_time.localeCompare(b.event_time));

    const ext = dayEvents.filter(e => !e.access_point || !internalPoints.has(e.access_point));
    const src = ext.length > 0 ? ext : dayEvents;
    const entries = src.filter(e => e.direction === 'entry');
    const exits = src.filter(e => e.direction === 'exit');
    const firstEntry = entries.length > 0 ? entries[0].event_time : null;
    const lastExit = exits.length > 0 ? exits[exits.length - 1].event_time : null;

    const isToday = dateStr === todayStr;
    const pairs = buildPairs(dayEvents, internalPoints, isToday);
    const totalMinutes = pairs.reduce((s, p) => s + p.durationMinutes, 0);
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;

    groups.push({
      date: dateStr,
      dayName: DAY_NAMES[dow],
      events: dayEvents,
      firstEntry,
      lastExit,
      totalMinutes,
      isToday,
      isWeekend: dow >= 5,
      isFuture: dateStr > todayStr,
      pairs,
    });
  }
  return groups;
};

const getPeriodRange = (period: ViewPeriod, offset: number): { startDate: string; endDate: string; label: string } => {
  const today = new Date();

  if (period === 'day') {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    const dateStr = toLocalISO(d);
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
    return { startDate: toLocalISO(start), endDate: toLocalISO(end), label };
  }

  // month
  const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const label = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  return { startDate: toLocalISO(d), endDate: toLocalISO(last), label };
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

  useEffect(() => {
    if (!profile?.employee_id && refreshProfile) {
      refreshProfile();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const dayGroups = useMemo(
    () => buildDayGroups(skudEvents, periodRange.startDate, periodRange.endDate, internalPoints),
    [skudEvents, periodRange.startDate, periodRange.endDate, internalPoints],
  );

  const isCurrentPeriod = periodOffset === 0;

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
          dayGroups={dayGroups}
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

      {activeModal && (
        <RequestModal activeModal={activeModal} onClose={() => setActiveModal(null)} />
      )}
    </div>
  );
};
