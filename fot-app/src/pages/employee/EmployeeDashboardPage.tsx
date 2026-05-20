import React, { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { apiClient } from '../../api/client';
import { employeeService } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import type { Employee, SkudEvent, IAccessPointSetting, TimesheetEntry, TimesheetStatus } from '../../types';
import { DayEvents, DaySummaryBadges, formatHM } from '../../components/dashboard/AttendanceCard';
import type { IDayGroup, IEntryExitPair } from '../../components/dashboard/AttendanceCard';
import { useEmployeeTimesheetMonths } from '../../hooks/useEmployeeTimesheet';
import { useMyLeaveRequests } from '../../hooks/usePortalData';
import {
  CORRECTION_STATUS_LABELS,
  STATUS_LABELS as LR_STATUS_LABELS,
  type ILeaveRequest,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import styles from './EmployeeDashboard.module.css';

const EmployeeInfoCards = lazy(() => import('../../components/dashboard/EmployeeInfoCards').then(m => ({ default: m.EmployeeInfoCards })));
const DailyTasksCard = lazy(() => import('../../components/dashboard/DailyTasksCard').then(m => ({ default: m.DailyTasksCard })));
const UnifiedRequestModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.UnifiedRequestModal })));
const TwoFAModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.TwoFAModal })));
const MyMonthTimesheet = lazy(() => import('../../components/dashboard/MyMonthTimesheet').then(m => ({ default: m.MyMonthTimesheet })));

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
  unpaid: 'За свой счёт',
  educational_leave: 'Учебный отпуск',
};
const WORKED_STATUSES = new Set<TimesheetStatus>(['work', 'manual', 'remote']);

const REQ_STATUS_PRIORITY: Record<LeaveRequestStatus, number> = {
  pending: 3,
  approved: 2,
  rejected: 1,
  cancelled: 0,
};

const pad2 = (n: number) => String(n).padStart(2, '0');

const formatActiveDayLabel = (iso: string): string =>
  new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

const buildPairs = (events: SkudEvent[], internalPoints: Set<string>, isToday: boolean): IEntryExitPair[] => {
  const sorted = events.filter(e => !e.access_point || !internalPoints.has(e.access_point));
  const pairs: IEntryExitPair[] = [];
  let currentEntry: SkudEvent | null = null;

  for (const ev of sorted) {
    if (ev.direction === 'entry') {
      if (currentEntry === null) currentEntry = ev;
    } else if (ev.direction === 'exit' && currentEntry !== null) {
      const dur = timeToSeconds(ev.event_time) - timeToSeconds(currentEntry.event_time);
      pairs.push({ entry: currentEntry, exit: ev, durationMinutes: Math.round(dur / 60), breakMinutesAfter: null });
      currentEntry = null;
    }
  }
  if (currentEntry && isToday) {
    const now = new Date();
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const dur = nowSec - timeToSeconds(currentEntry.event_time);
    if (dur > 0) {
      pairs.push({ entry: currentEntry, exit: null, durationMinutes: Math.round(dur / 60), breakMinutesAfter: null });
    }
  }
  pairs.forEach((pair, i) => {
    const next = pairs[i + 1];
    if (pair.exit && next?.entry) {
      const gap = timeToSeconds(next.entry.event_time) - timeToSeconds(pair.exit.event_time);
      pair.breakMinutesAfter = gap > 0 ? Math.round(gap / 60) : null;
    }
  });
  return pairs;
};

const buildDayGroup = (
  dateStr: string,
  timesheetEntries: TimesheetEntry[],
  events: SkudEvent[],
  internalPoints: Set<string>,
): IDayGroup => {
  const todayStr = toLocalISO(new Date());
  const entry = timesheetEntries.find(e => e.work_date === dateStr) ?? null;
  const dayEvents = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time));

  const src = dayEvents.filter(e => !e.access_point || !internalPoints.has(e.access_point));
  const directionEntries = src.filter(e => e.direction === 'entry');
  const exits = src.filter(e => e.direction === 'exit');

  const isToday = dateStr === todayStr;
  const pairs = buildPairs(dayEvents, internalPoints, isToday);
  const rawTotalMinutes = pairs.reduce((sum, pair) => sum + pair.durationMinutes, 0);
  const totalBreakMinutes = pairs.reduce((sum, pair) => sum + (pair.breakMinutesAfter ?? 0), 0);
  const canonicalMinutes = entry?.hours_worked != null
    ? Math.max(0, Math.round(entry.hours_worked * 60))
    : 0;
  const hasWorkedStatus = entry ? WORKED_STATUSES.has(entry.status) : rawTotalMinutes > 0;
  const totalMinutes = isToday && rawTotalMinutes > 0 && (!entry || hasWorkedStatus)
    ? Math.max(canonicalMinutes, rawTotalMinutes)
    : (canonicalMinutes > 0 || entry ? canonicalMinutes : rawTotalMinutes);

  const firstEntry = entry?.first_entry ?? (directionEntries.length > 0 ? directionEntries[0].event_time : null);
  const lastExit = entry?.last_exit ?? (exits.length > 0 ? exits[exits.length - 1].event_time : null);
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
  const status = entry?.status ?? (dayEvents.length > 0 ? 'work' : null);

  return {
    date: dateStr,
    dayName: DAY_NAMES[dow],
    events: dayEvents,
    firstEntry,
    lastExit,
    totalMinutes,
    totalBreakMinutes,
    isToday,
    isWeekend: dow >= 5 && !hasWorkedStatus,
    isFuture: dateStr > todayStr,
    pairs,
    status,
    statusLabel: status ? STATUS_LABELS[status] : null,
    isCorrection: Boolean(entry?.is_correction),
    hasSkudDetails: dayEvents.length > 0,
    hasCanonicalEntry: Boolean(entry),
  };
};

export const EmployeeDashboardPage: React.FC = () => {

  const { user, profile, refreshProfile, isTwoFactorEnabled, timesheetMonthsBack, timesheetMonthsForward } = useAuth();
  const { showToast } = useToast();
  const [showRequestModal, setShowRequestModal] = useState(false);

  const todayIso = useMemo(() => toLocalISO(new Date()), []);
  const [activeDayIso, setActiveDayIso] = useState<string>(todayIso);

  // 2FA state
  const [show2FASetup, setShow2FASetup] = useState(false);
  const [twoFAData, setTwoFAData] = useState<{ secret: string; qrCode: string; recoveryCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [isEnabling2FA, setIsEnabling2FA] = useState(false);

  const employeeId = profile?.employee_id ?? null;

  // Загружаем окно [now - monthsBack .. now + monthsForward], настроенное per-role
  // (см. system_roles.timesheet_months_back / timesheet_months_forward, миграция 094).
  const timesheetMonthKeys = useMemo(() => {
    const today = new Date();
    const result: string[] = [];
    for (let offset = -timesheetMonthsBack; offset <= timesheetMonthsForward; offset += 1) {
      const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      result.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
    }
    return result;
  }, [timesheetMonthsBack, timesheetMonthsForward]);

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
    enabled: !!employeeId,
    staleTime: 10 * 60_000,
  });

  const timesheetQuery = useEmployeeTimesheetMonths(employeeId, timesheetMonthKeys, !!employeeId);
  const leaveRequestsQuery = useMyLeaveRequests();

  const skudEventsQuery = useQuery<SkudEvent[]>({
    queryKey: ['employee-dashboard-skud-events', employeeId, activeDayIso],
    enabled: !!employeeId,
    staleTime: 30_000,
    queryFn: () => skudService.getEmployeeEvents(
      employeeId as number,
      activeDayIso,
      activeDayIso,
    ).catch(() => [] as SkudEvent[]),
  });

  const employee = employeeQuery.data ?? null;

  const timesheetEntries = useMemo(() => {
    const uniqueEntries = new Map<string, TimesheetEntry>();
    for (const response of timesheetQuery.data) {
      for (const entry of response.entries || []) {
        if (entry.employee_id !== employeeId) continue;
        uniqueEntries.set(entry.work_date, entry);
      }
    }
    return Array.from(uniqueEntries.values()).sort((a, b) => a.work_date.localeCompare(b.work_date));
  }, [employeeId, timesheetQuery.data]);

  const skudEvents = useMemo(() => skudEventsQuery.data ?? [], [skudEventsQuery.data]);
  const internalPoints = useMemo(
    () => new Set((accessPointsQuery.data ?? []).filter(point => point.is_internal).map(point => point.access_point_name)),
    [accessPointsQuery.data],
  );

  const loading = employeeQuery.isLoading || timesheetQuery.isLoading || accessPointsQuery.isLoading;
  const eventsLoading = skudEventsQuery.isLoading;

  const activeDayGroup = useMemo(
    () => buildDayGroup(activeDayIso, timesheetEntries, skudEvents, internalPoints),
    [activeDayIso, timesheetEntries, skudEvents, internalPoints],
  );

  const activeCorrection = useMemo<ILeaveRequest | null>(() => {
    const list = leaveRequestsQuery.data ?? [];
    let best: ILeaveRequest | null = null;
    for (const req of list) {
      if (req.request_type !== 'time_correction') continue;
      if (req.status === 'cancelled') continue;
      if (req.correction_date !== activeDayIso) continue;
      if (!best || REQ_STATUS_PRIORITY[req.status] > REQ_STATUS_PRIORITY[best.status]) {
        best = req;
      }
    }
    return best;
  }, [leaveRequestsQuery.data, activeDayIso]);

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

  const hasEventsData = activeDayGroup.hasSkudDetails || activeDayGroup.hasCanonicalEntry;

  return (
    <div className={styles.content}>
      {/* Header with request button (заголовок «Личный кабинет» уже в верхней панели) */}
      <div className={styles.sectionHeader}>
        <button className="btn-primary" onClick={() => setShowRequestModal(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Подать заявление
        </button>
      </div>

      {/* Content Grid */}
      <div className={styles.contentGrid}>
        {/* Calendar + Day Events */}
        <div className={styles.calendarEventsBlock}>
          {/* Left: Calendar */}
          <div className={styles.calendarPane}>
            <Suspense fallback={<div className={styles.emptyState}>Загрузка...</div>}>
              <MyMonthTimesheet
                employeeId={employeeId}
                activeDayIso={activeDayIso}
                onDayActivate={setActiveDayIso}
                noCard
              />
            </Suspense>
          </div>

          {/* Right: Day Events */}
          <div className={styles.eventsPane}>
            <div className={styles.eventsPaneHeader}>
              <span className={styles.eventsPaneDate}>{formatActiveDayLabel(activeDayIso)}</span>
              {hasEventsData && <DaySummaryBadges group={activeDayGroup} hideDuration />}
            </div>
            <div className={styles.eventsPaneBody}>
              {loading || eventsLoading ? (
                <div className={styles.emptyState}>Загрузка...</div>
              ) : hasEventsData ? (
                <DayEvents group={activeDayGroup} />
              ) : (
                <div className={styles.emptyState}>
                  {activeDayGroup.isFuture ? 'Будущая дата' : 'Нет данных за этот день'}
                </div>
              )}
            </div>
            {activeCorrection && (
              <div className={styles.correctionInfo}>
                <div className={styles.correctionInfoHeader}>
                  <span className={styles.correctionInfoTitle}>Корректировка</span>
                  <span
                    className={`${styles.correctionInfoStatus} ${styles[`correctionStatus_${activeCorrection.status}`]}`}
                  >
                    {LR_STATUS_LABELS[activeCorrection.status]}
                  </span>
                </div>
                {(activeCorrection.correction_status || activeCorrection.correction_hours != null) && (
                  <div className={styles.correctionInfoBody}>
                    {activeCorrection.correction_status && (
                      <span>
                        {CORRECTION_STATUS_LABELS[activeCorrection.correction_status] ?? activeCorrection.correction_status}
                      </span>
                    )}
                    {activeCorrection.correction_hours != null && (
                      <span> · {activeCorrection.correction_hours}ч</span>
                    )}
                  </div>
                )}
                {activeCorrection.reason && (
                  <div className={styles.correctionInfoReason}>{activeCorrection.reason}</div>
                )}
              </div>
            )}
            {(activeDayGroup.totalMinutes > 0 || activeDayGroup.totalBreakMinutes > 0) && (
              <div className={styles.eventsPaneFooter}>
                {activeDayGroup.totalMinutes > 0 && (
                  <div className={styles.eventsPaneFooterRow}>
                    <span>Итого за день:</span>
                    <strong>{formatHM(activeDayGroup.totalMinutes)}</strong>
                  </div>
                )}
                {activeDayGroup.totalBreakMinutes > 0 && (
                  <div className={styles.eventsPaneFooterRow}>
                    <span>Перерыв:</span>
                    <strong>{formatHM(activeDayGroup.totalBreakMinutes)}</strong>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right column: Employee Info */}
        <div className={styles.rightColumn}>
          <Suspense fallback={DashboardCardFallback}>
            <DailyTasksCard />
          </Suspense>
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

      {showRequestModal && (
        <Suspense fallback={null}>
          <UnifiedRequestModal
            employeeId={employeeId}
            onClose={() => setShowRequestModal(false)}
          />
        </Suspense>
      )}
    </div>
  );
};
