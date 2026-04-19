import React, { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { apiClient } from '../../api/client';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import type { Employee, SkudEvent, IAccessPointSetting, TimesheetEntry, TimesheetStatus } from '../../types';
import { AttendanceCard } from '../../components/dashboard/AttendanceCard';
import type { IDayGroup, IEntryExitPair } from '../../components/dashboard/AttendanceCard';
import { useEmployeeTimesheetMonths } from '../../hooks/useEmployeeTimesheet';
import styles from './EmployeeDashboard.module.css';

const EmployeeInfoCards = lazy(() => import('../../components/dashboard/EmployeeInfoCards').then(m => ({ default: m.EmployeeInfoCards })));
const RequestModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.RequestModal })));
const TwoFAModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.TwoFAModal })));
const MyMonthTimesheet = lazy(() => import('../../components/dashboard/MyMonthTimesheet').then(m => ({ default: m.MyMonthTimesheet })));

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
const STATUS_LABELS: Record<TimesheetStatus, string> = {
  work: 'Работа',
  manual: 'Работа',
  remote: 'Удалёнка',
  sick: 'Больничный',
  vacation: 'Отпуск',
  dayoff: 'Выходной',
  absent: 'Неявка',
  business_trip: 'Командировка',
  unpaid: 'Без содержания',
};
const WORKED_STATUSES = new Set<TimesheetStatus>(['work', 'manual', 'remote', 'business_trip']);

const getRangeMonthKeys = (startDate: string, endDate: string): string[] => {
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  const cursor = new Date(startYear, startMonth - 1, 1);
  const finish = new Date(endYear, endMonth - 1, 1);
  const result: string[] = [];

  while (cursor <= finish) {
    result.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return result;
};

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
  startDate: string,
  endDate: string,
  timesheetEntries: TimesheetEntry[],
  events: SkudEvent[],
  internalPoints: Set<string>,
): IDayGroup[] => {
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const todayStr = toLocalISO(new Date());
  const groups: IDayGroup[] = [];
  const eventsByDate = new Map<string, SkudEvent[]>();
  const entriesByDate = new Map<string, TimesheetEntry>();

  for (const event of events) {
    const bucket = eventsByDate.get(event.event_date);
    if (bucket) bucket.push(event);
    else eventsByDate.set(event.event_date, [event]);
  }

  for (const entry of timesheetEntries) {
    entriesByDate.set(entry.work_date, entry);
  }

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = toLocalISO(d);
    const entry = entriesByDate.get(dateStr) ?? null;
    const dayEvents = [...(eventsByDate.get(dateStr) ?? [])].sort((a, b) => a.event_time.localeCompare(b.event_time));

    const ext = dayEvents.filter(e => !e.access_point || !internalPoints.has(e.access_point));
    const src = ext.length > 0 ? ext : dayEvents;
    const directionEntries = src.filter(e => e.direction === 'entry');
    const exits = src.filter(e => e.direction === 'exit');

    const isToday = dateStr === todayStr;
    const pairs = buildPairs(dayEvents, internalPoints, isToday);
    const rawTotalMinutes = pairs.reduce((sum, pair) => sum + pair.durationMinutes, 0);
    const canonicalMinutes = entry?.hours_worked != null
      ? Math.max(0, Math.round(entry.hours_worked * 60))
      : 0;
    const hasWorkedStatus = entry ? WORKED_STATUSES.has(entry.status) : rawTotalMinutes > 0;
    const totalMinutes = isToday && rawTotalMinutes > 0 && (!entry || hasWorkedStatus)
      ? Math.max(canonicalMinutes, rawTotalMinutes)
      : (canonicalMinutes > 0 || entry ? canonicalMinutes : rawTotalMinutes);
    const firstEntry = entry?.first_entry ?? (directionEntries.length > 0 ? directionEntries[0].event_time : null);
    const lastExit = entry?.last_exit ?? (exits.length > 0 ? exits[exits.length - 1].event_time : null);
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const status = entry?.status ?? (dayEvents.length > 0 ? 'work' : null);

    groups.push({
      date: dateStr,
      dayName: DAY_NAMES[dow],
      events: dayEvents,
      firstEntry,
      lastExit,
      totalMinutes,
      isToday,
      isWeekend: dow >= 5 && !hasWorkedStatus,
      isFuture: dateStr > todayStr,
      pairs,
      status,
      statusLabel: status ? STATUS_LABELS[status] : null,
      isCorrection: Boolean(entry?.is_correction),
      hasSkudDetails: dayEvents.length > 0,
      hasCanonicalEntry: Boolean(entry),
    });
  }
  return groups;
};

// Сотрудник в ЛК видит свои данные только за текущий и прошлый месяц.
// Нижняя граница: первое число прошлого месяца.
const getMinOffset = (period: ViewPeriod): number => {
  const today = new Date();
  const minDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);

  if (period === 'month') return -1;
  if (period === 'day') {
    const msPerDay = 86_400_000;
    const diff = Math.floor((today.getTime() - minDate.getTime()) / msPerDay);
    return -diff;
  }
  // week
  const currentDay = today.getDay() === 0 ? 6 : today.getDay() - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - currentDay);
  const minDaysDiff = Math.floor((monday.getTime() - minDate.getTime()) / 86_400_000);
  return -Math.ceil(minDaysDiff / 7);
};

const clampOffset = (period: ViewPeriod, offset: number): number => {
  const min = getMinOffset(period);
  if (offset < min) return min;
  if (offset > 0) return 0;
  return offset;
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
  const [presetDates, setPresetDates] = useState<{ start: string; end: string } | null>(null);

  // Period navigation
  const [viewPeriod, setViewPeriod] = useState<ViewPeriod>('day');
  const [periodOffsetRaw, setPeriodOffsetRaw] = useState(0);
  const periodOffset = clampOffset(viewPeriod, periodOffsetRaw);
  const canGoBack = periodOffset > getMinOffset(viewPeriod);
  const setPeriodOffset = (updater: (o: number) => number) => {
    setPeriodOffsetRaw(current => clampOffset(viewPeriod, updater(current)));
  };

  // 2FA state
  const [show2FASetup, setShow2FASetup] = useState(false);
  const [twoFAData, setTwoFAData] = useState<{ secret: string; qrCode: string; recoveryCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [isEnabling2FA, setIsEnabling2FA] = useState(false);

  const employeeId = profile?.employee_id ?? null;
  const periodRange = useMemo(() => getPeriodRange(viewPeriod, periodOffset), [viewPeriod, periodOffset]);
  const periodMonthKeys = useMemo(
    () => getRangeMonthKeys(periodRange.startDate, periodRange.endDate),
    [periodRange.endDate, periodRange.startDate],
  );
  const shouldLoadSkudDetails = viewPeriod !== 'month';

  useEffect(() => {
    if (!employeeId && refreshProfile) {
      refreshProfile();
    }
  }, [employeeId, refreshProfile]);

  const employeeQuery = useQuery<Employee | null>({
    queryKey: ['employee', employeeId],
    queryFn: () => employeeService.getById(employeeId as number),
    enabled: !!employeeId,
    staleTime: 60_000,
  });

  const accessPointsQuery = useQuery<IAccessPointSetting[]>({
    queryKey: ['skud-access-point-settings'],
    queryFn: () => skudService.getAccessPointSettings().catch(() => [] as IAccessPointSetting[]),
    enabled: shouldLoadSkudDetails,
    staleTime: 10 * 60_000,
  });

  const timesheetQuery = useEmployeeTimesheetMonths(employeeId, periodMonthKeys, !!employeeId);

  const skudEventsQuery = useQuery<SkudEvent[]>({
    queryKey: ['employee-dashboard-skud-events', employeeId, periodRange.startDate, periodRange.endDate],
    enabled: !!employeeId && shouldLoadSkudDetails,
    staleTime: 30_000,
    queryFn: () => skudService.getEmployeeEvents(
      employeeId as number,
      periodRange.startDate,
      periodRange.endDate,
    ).catch(() => [] as SkudEvent[]),
  });

  const employee = employeeQuery.data ?? null;
  const timesheetEntries = useMemo(() => {
    const uniqueEntries = new Map<string, TimesheetEntry>();
    for (const response of timesheetQuery.data) {
      for (const entry of response.entries || []) {
        if (entry.employee_id !== employeeId) continue;
        if (entry.work_date < periodRange.startDate || entry.work_date > periodRange.endDate) continue;
        uniqueEntries.set(entry.work_date, entry);
      }
    }
    return Array.from(uniqueEntries.values()).sort((a, b) => a.work_date.localeCompare(b.work_date));
  }, [employeeId, periodRange.endDate, periodRange.startDate, timesheetQuery.data]);
  const skudEvents = useMemo(() => skudEventsQuery.data ?? [], [skudEventsQuery.data]);
  const internalPoints = useMemo(
    () => new Set((accessPointsQuery.data ?? []).filter(point => point.is_internal).map(point => point.access_point_name)),
    [accessPointsQuery.data],
  );
  const loading = employeeQuery.isLoading || timesheetQuery.isLoading || (shouldLoadSkudDetails && accessPointsQuery.isLoading);
  const eventsLoading = shouldLoadSkudDetails ? skudEventsQuery.isLoading : false;

  const dayGroups = useMemo(
    () => buildDayGroups(periodRange.startDate, periodRange.endDate, timesheetEntries, skudEvents, internalPoints),
    [periodRange.startDate, periodRange.endDate, timesheetEntries, skudEvents, internalPoints],
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

  const DashboardCardFallback = (
    <div className={styles.infoCard}>
      <div className={styles.emptyState}>Загрузка...</div>
    </div>
  );

  return (
    <div className={styles.content}>
      {/* Quick Actions */}
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Подать заявление</h2>
      </div>
      <div className={styles.quickActionsGrid}>
        {(['vacation','sick','remote','docs'] as RequestType[]).map((type) => (
          <div key={type} className={styles.quickActionCard} onClick={() => { setPresetDates(null); setActiveModal(type); }}>
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

      {/* Месячный табель с возможностью подачи заявки на выбранные дни */}
      <Suspense fallback={DashboardCardFallback}>
        <MyMonthTimesheet
          employeeId={employeeId}
          onSubmitRequest={(dates) => {
            setPresetDates({ start: dates[0], end: dates[dates.length - 1] });
            setActiveModal('remote');
          }}
        />
      </Suspense>

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
          canGoBack={canGoBack}
          dayGroups={dayGroups}
        />

        <div className={styles.rightColumn}>
          <Suspense fallback={DashboardCardFallback}>
            <EmployeeInfoCards
              loading={loading}
              employee={employee}
              importedPosition={profile?.imported_position ?? undefined}
              email={user?.email ?? undefined}
              isTwoFactorEnabled={isTwoFactorEnabled}
              onSetup2FA={handleSetup2FA}
              onDisable2FA={handleDisable2FA}
            />
          </Suspense>
        </div>
      </div>

      {show2FASetup && twoFAData && (
        <Suspense fallback={null}>
          <TwoFAModal
            twoFAData={twoFAData}
            verifyCode={verifyCode}
            setVerifyCode={setVerifyCode}
            isEnabling2FA={isEnabling2FA}
            onEnable={handleEnable2FA}
            onClose={() => setShow2FASetup(false)}
          />
        </Suspense>
      )}

      {activeModal && (
        <Suspense fallback={null}>
          <RequestModal
            activeModal={activeModal}
            onClose={() => { setActiveModal(null); setPresetDates(null); }}
            employeeId={employeeId}
            presetDates={presetDates}
          />
        </Suspense>
      )}
    </div>
  );
};
